// Content script: article extraction (via Readability), selection
// text lookup, the on-page reader overlay / mini-player UI, AND
// actual audio playback. Playback lives here (not in the background
// service worker) because this is a real page document in both
// Firefox and Chromium -- unlike an MV3 service worker, which has no
// DOM at all, this never needs an offscreen-document workaround.
import browser from "webextension-polyfill";
import { Readability } from "@mozilla/readability";
import { DEFAULT_SETTINGS, STORAGE_KEY } from "../common/constants.js";

const HIGHLIGHT_CLASS = "kokoro-current";

let rootEl = null;
let overlayEls = null; // { backdrop, statusEl, toggleBtn, article, segmentEls: Map, title }
let miniPlayerEls = null; // { bar, statusEl, toggleBtn, expandBtn }
let currentMode = null; // "page" | "selection" | null
let minimized = false;

// --- playback state ---------------------------------------------------
let currentJobId = null;
let segmentCount = 0;
let currentSegmentIndex = 0;
let currentSegmentId = null;
let localStatus = "idle"; // idle | loading | synthesizing | playing | paused | error
let errorMessage = null;

const queue = []; // { url, segmentId, segmentIndex, isLastChunk }
let playingItem = null;
const audioEl = new Audio();
audioEl.autoplay = false;

// Volume is purely a playback concern (the server always returns
// full-amplitude audio), so it's applied here directly rather than
// threaded through background/job messages. Read once on load, then
// kept live via storage.onChanged so a mid-read change (from the
// popup or options page) takes effect immediately on whatever's
// already playing, not just the next job.
function clampVolume(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : DEFAULT_SETTINGS.volume;
}

browser.storage.local.get(STORAGE_KEY).then((stored) => {
  audioEl.volume = clampVolume((stored[STORAGE_KEY] || {}).volume ?? DEFAULT_SETTINGS.volume);
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORAGE_KEY]) {
    const newSettings = changes[STORAGE_KEY].newValue || {};
    audioEl.volume = clampVolume(newSettings.volume ?? DEFAULT_SETTINGS.volume);
  }
});

// --- background-page keepalive ------------------------------------------
// A non-persistent background page/service worker can be suspended by
// the browser mid-read: our background script's synthesis loop is
// just a sequence of plain fetch() calls, which -- unlike WebExtension
// API activity -- isn't reliably recognized as "this extension is
// busy" by Firefox's idle-suspension logic. That kills the loop
// silently (no error, no cleanup) partway through a long article,
// which is exactly what was happening. Holding a live runtime.Port
// open for the duration of a job is the standard, documented way to
// keep it alive.
let keepAlivePort = null;

function openKeepAlive() {
  if (keepAlivePort) return;
  keepAlivePort = browser.runtime.connect({ name: "kokoro-keepalive" });
  keepAlivePort.onDisconnect.addListener(() => {
    keepAlivePort = null;
  });
}

function closeKeepAlive() {
  if (!keepAlivePort) return;
  try {
    keepAlivePort.disconnect();
  } catch {
    // already gone, nothing to do
  }
  keepAlivePort = null;
}

function ensureRoot() {
  if (rootEl && document.documentElement.contains(rootEl)) return rootEl;
  rootEl = document.createElement("div");
  rootEl.id = "kokoro-reader-root";
  document.documentElement.appendChild(rootEl);
  return rootEl;
}

function extractArticle() {
  let article = null;
  try {
    const clone = document.cloneNode(true);
    article = new Readability(clone, { charThreshold: 200 }).parse();
  } catch {
    article = null;
  }

  if (article && article.content) {
    const doc = new DOMParser().parseFromString(article.content, "text/html");
    const blocks = doc.body.querySelectorAll(
      "p, li, h1, h2, h3, h4, h5, h6, blockquote"
    );
    const segments = [];
    let idx = 0;
    blocks.forEach((el) => {
      const text = el.textContent.replace(/\s+/g, " ").trim();
      if (text.length < 2) return;
      segments.push({ id: `seg-${idx++}`, text, tag: el.tagName.toLowerCase() });
    });
    if (segments.length > 0) {
      return { title: article.title || document.title, segments };
    }
  }

  // Fallback for pages Readability can't parse as an article: split
  // the visible text of <body> into paragraph-ish chunks.
  const rawParagraphs = (document.body.innerText || "")
    .split(/\n{2,}/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 1);
  const segments = rawParagraphs.map((text, idx) => ({
    id: `seg-${idx}`,
    text,
    tag: "p",
  }));
  return { title: document.title, segments };
}

// --- playback engine -----------------------------------------------------

function reportEvent(kind, extra = {}) {
  browser.runtime.sendMessage({ type: "contentEvent", jobId: currentJobId, kind, ...extra }).catch(() => {});
}

function maybeStartPlayback() {
  if (playingItem || queue.length === 0) return;
  if (localStatus === "paused") return;
  playingItem = queue.shift();
  currentSegmentIndex = playingItem.segmentIndex;
  if (currentSegmentId !== playingItem.segmentId) {
    currentSegmentId = playingItem.segmentId;
    reportEvent("segmentStarted", { segmentId: playingItem.segmentId, segmentIndex: playingItem.segmentIndex });
  }
  audioEl.src = playingItem.url;
  localStatus = "playing";
  updateStatusUI();
  audioEl.play().catch((err) => {
    failPlayback(`Playback failed: ${err.message}`);
  });
}

audioEl.addEventListener("ended", () => {
  const wasLast = playingItem && playingItem.isLastChunk;
  if (playingItem) {
    URL.revokeObjectURL(playingItem.url);
    playingItem = null;
  }
  if (wasLast) {
    reportEvent("allPlaybackDone");
    teardownPlayback();
    closeAll();
    return;
  }
  if (queue.length > 0) {
    maybeStartPlayback();
  } else {
    localStatus = "synthesizing"; // caught up with the server, waiting for more
    updateStatusUI();
    reportEvent("buffering");
  }
});

function failPlayback(message) {
  errorMessage = message;
  localStatus = "error";
  updateStatusUI();
  reportEvent("playbackError", { message });
  teardownPlayback();
}

function clearQueue() {
  for (const item of queue) URL.revokeObjectURL(item.url);
  queue.length = 0;
  if (playingItem) {
    URL.revokeObjectURL(playingItem.url);
    playingItem = null;
  }
}

function teardownPlayback() {
  audioEl.pause();
  audioEl.removeAttribute("src");
  clearQueue();
  currentJobId = null;
  currentSegmentId = null;
  closeKeepAlive();
}

function sendToggle() {
  if (localStatus === "paused") {
    localStatus = "playing";
    updateStatusUI();
    audioEl.play().catch(() => {});
    reportEvent("userResumed");
  } else {
    localStatus = "paused";
    updateStatusUI();
    audioEl.pause();
    reportEvent("userPaused");
  }
}

function sendStop() {
  reportEvent("userStopped");
  teardownPlayback();
  closeAll();
}

// --- shared control bar builder ----------------------------------------

function buildControls({ onToggle, onMinimize, onStop, onClose }) {
  const controls = document.createElement("div");
  controls.className = "kokoro-controls";

  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "kokoro-btn kokoro-btn-toggle";
  toggleBtn.textContent = "❚❚";
  toggleBtn.title = "Pause";
  toggleBtn.addEventListener("click", onToggle);
  controls.appendChild(toggleBtn);

  let minimizeBtn = null;
  if (onMinimize) {
    minimizeBtn = document.createElement("button");
    minimizeBtn.type = "button";
    minimizeBtn.className = "kokoro-btn kokoro-btn-minimize";
    minimizeBtn.textContent = "—";
    minimizeBtn.title = "Minimize (keeps playing)";
    minimizeBtn.addEventListener("click", onMinimize);
    controls.appendChild(minimizeBtn);
  }

  const stopBtn = document.createElement("button");
  stopBtn.type = "button";
  stopBtn.className = "kokoro-btn kokoro-btn-stop";
  stopBtn.textContent = "◼";
  stopBtn.title = "Stop";
  stopBtn.addEventListener("click", onStop);
  controls.appendChild(stopBtn);

  if (onClose) {
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "kokoro-btn kokoro-btn-close";
    closeBtn.textContent = "✕";
    closeBtn.title = "Close";
    closeBtn.addEventListener("click", onClose);
    controls.appendChild(closeBtn);
  }

  return { controls, toggleBtn, minimizeBtn, stopBtn };
}

// --- overlay (article reading mode) -------------------------------------

function showOverlay(title, segments) {
  closeAll();
  currentMode = "page";
  minimized = false;
  const root = ensureRoot();

  const backdrop = document.createElement("div");
  backdrop.className = "kokoro-overlay";

  const panel = document.createElement("div");
  panel.className = "kokoro-panel";

  const header = document.createElement("div");
  header.className = "kokoro-header";

  const titleEl = document.createElement("div");
  titleEl.className = "kokoro-title";
  titleEl.textContent = title || "Reading article";

  const statusEl = document.createElement("div");
  statusEl.className = "kokoro-status";

  const { controls, toggleBtn } = buildControls({
    onToggle: sendToggle,
    onMinimize: minimizeOverlay,
    onStop: sendStop,
    onClose: sendStop,
  });

  header.appendChild(titleEl);
  header.appendChild(statusEl);
  header.appendChild(controls);

  const articleEl = document.createElement("div");
  articleEl.className = "kokoro-article";

  const segmentEls = new Map();
  for (const seg of segments) {
    const tag = /^h[1-6]$/.test(seg.tag) ? seg.tag : seg.tag === "li" ? "li" : "p";
    const el = document.createElement(tag);
    el.className = "kokoro-segment";
    el.textContent = seg.text;
    el.dataset.kokoroId = seg.id;
    el.addEventListener("click", () => {
      browser.runtime.sendMessage({ type: "seekSegment", segmentId: seg.id });
    });
    articleEl.appendChild(el);
    segmentEls.set(seg.id, el);
  }

  panel.appendChild(header);
  panel.appendChild(articleEl);
  backdrop.appendChild(panel);
  root.appendChild(backdrop);

  overlayEls = {
    backdrop,
    statusEl,
    toggleBtn,
    article: articleEl,
    segmentEls,
    title: title || "Reading article",
  };
}

function minimizeOverlay() {
  if (!overlayEls || minimized) return;
  overlayEls.backdrop.style.display = "none";
  minimized = true;
  showMiniBar();
}

function restoreOverlay() {
  if (!overlayEls || !minimized) return;
  overlayEls.backdrop.style.display = "";
  minimized = false;
  if (miniPlayerEls) {
    miniPlayerEls.bar.remove();
    miniPlayerEls = null;
  }
}

// --- mini player (selection reading mode, and minimized article mode) ----

function showMiniBar() {
  if (miniPlayerEls) return;
  const root = ensureRoot();

  const bar = document.createElement("div");
  bar.className = "kokoro-mini";

  let expandBtn = null;
  if (currentMode === "page") {
    expandBtn = document.createElement("button");
    expandBtn.type = "button";
    expandBtn.className = "kokoro-btn kokoro-btn-expand";
    expandBtn.textContent = "⤢";
    expandBtn.title = "Expand";
    expandBtn.addEventListener("click", restoreOverlay);
    bar.appendChild(expandBtn);
  }

  const statusEl = document.createElement("div");
  statusEl.className = "kokoro-mini-status";
  statusEl.textContent = (currentMode === "page" && overlayEls && overlayEls.title) || "Kokoro Reader";

  const { controls, toggleBtn } = buildControls({ onToggle: sendToggle, onStop: sendStop });
  controls.classList.add("kokoro-mini-controls");

  bar.appendChild(statusEl);
  bar.appendChild(controls);
  root.appendChild(bar);

  miniPlayerEls = { bar, statusEl, toggleBtn, expandBtn };
}

function showMiniPlayer() {
  closeAll();
  currentMode = "selection";
  minimized = false;
  showMiniBar();
}

function closeAll() {
  if (overlayEls) {
    overlayEls.backdrop.remove();
    overlayEls = null;
  }
  if (miniPlayerEls) {
    miniPlayerEls.bar.remove();
    miniPlayerEls = null;
  }
  currentMode = null;
  minimized = false;
}

// --- status UI -------------------------------------------------------------

function statusLabel() {
  switch (localStatus) {
    case "loading":
      return "Connecting to server…";
    case "synthesizing":
      return "Synthesizing…";
    case "playing":
      return segmentCount > 1 ? `Reading ${currentSegmentIndex + 1} / ${segmentCount}` : "Reading…";
    case "paused":
      return "Paused";
    case "error":
      return errorMessage || "Error";
    default:
      return "";
  }
}

function updateStatusUI() {
  if (localStatus === "idle") {
    closeAll();
    return;
  }

  const label = statusLabel();
  const toggleGlyph = localStatus === "paused" ? "▶" : "❚❚";

  if (overlayEls) {
    overlayEls.statusEl.textContent = label;
    overlayEls.toggleBtn.textContent = toggleGlyph;
    overlayEls.toggleBtn.title = localStatus === "paused" ? "Resume" : "Pause";
    if (currentSegmentId) {
      for (const el of overlayEls.segmentEls.values()) {
        el.classList.remove(HIGHLIGHT_CLASS);
      }
      const current = overlayEls.segmentEls.get(currentSegmentId);
      if (current) {
        current.classList.add(HIGHLIGHT_CLASS);
        if (!minimized) current.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  }

  if (miniPlayerEls) {
    miniPlayerEls.statusEl.textContent = label || "Kokoro Reader";
    miniPlayerEls.toggleBtn.textContent = toggleGlyph;
    miniPlayerEls.toggleBtn.title = localStatus === "paused" ? "Resume" : "Pause";
  }
}

// --- messaging -------------------------------------------------------------

browser.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case "ping":
      return Promise.resolve(true);

    case "getSelectionText":
      return Promise.resolve({ text: String(window.getSelection()) });

    case "extractArticle":
      return Promise.resolve(extractArticle());

    case "startReading":
      openKeepAlive();
      currentJobId = msg.jobId;
      segmentCount = msg.segments.length;
      currentSegmentIndex = 0;
      currentSegmentId = null;
      errorMessage = null;
      clearQueue();
      localStatus = "loading";
      if (msg.mode === "page") {
        showOverlay(msg.title, msg.segments);
      } else {
        showMiniPlayer();
      }
      updateStatusUI();
      return undefined;

    case "audioChunk": {
      if (msg.jobId !== currentJobId) return undefined; // stale, ignore
      const url = URL.createObjectURL(new Blob([msg.buffer], { type: "audio/wav" }));
      queue.push({
        url,
        segmentId: msg.segmentId,
        segmentIndex: msg.segmentIndex,
        isLastChunk: msg.isLastChunk,
      });
      maybeStartPlayback();
      return undefined;
    }

    case "stopReading":
      if (msg.jobId != null && msg.jobId !== currentJobId) return undefined; // stale, ignore
      teardownPlayback();
      closeAll();
      return undefined;

    case "pauseReading":
      localStatus = "paused";
      updateStatusUI();
      audioEl.pause();
      return undefined;

    case "resumeReading":
      if (audioEl.src) {
        localStatus = "playing";
        updateStatusUI();
        audioEl.play().catch(() => {});
      } else {
        maybeStartPlayback();
      }
      return undefined;

    default:
      return undefined;
  }
});
