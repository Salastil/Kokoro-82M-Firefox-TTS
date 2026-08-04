// Content script: article extraction (via Readability), selection
// text lookup, and the on-page reader overlay / mini-player UI. Talks
// to the background page only -- never touches the TTS model or
// audio directly.
import { Readability } from "@mozilla/readability";

/* global browser */

const HIGHLIGHT_CLASS = "kokoro-current";

let rootEl = null;
let overlayEls = null; // { backdrop, statusEl, toggleBtn, article, segmentEls: Map, title }
let miniPlayerEls = null; // { bar, statusEl, toggleBtn, expandBtn }
let currentMode = null; // "page" | "selection" | null
let minimized = false;
let lastStatus = "idle";

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

function sendToggle() {
  if (lastStatus === "paused") {
    browser.runtime.sendMessage({ type: "resumePlayback" });
  } else {
    browser.runtime.sendMessage({ type: "pausePlayback" });
  }
}

function sendStop() {
  browser.runtime.sendMessage({ type: "stopPlayback" });
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

function gpuFallbackNote(state) {
  if (!state.deviceFellBack) return "";
  switch (state.deviceFallbackReason) {
    case "no-navigator-gpu":
      return state.gpuAvailableInWindow
        ? " (WebGPU works in this Firefox, but isn't exposed to background Workers yet — using CPU)"
        : " (WebGPU isn't available in this Firefox/profile — using CPU)";
    case "no-adapter":
      return " (No compatible WebGPU adapter found — using CPU)";
    case "adapter-error":
      return " (WebGPU adapter request failed — using CPU)";
    default:
      return " (GPU unavailable, using CPU)";
  }
}

function threadNote(state) {
  if (state.device !== "wasm" || !state.wasmThreads) return "";
  return state.wasmThreads === 1
    ? " · 1 CPU thread (slow, see Settings > Performance)"
    : ` · ${state.wasmThreads} CPU threads`;
}

function statusLabel(state) {
  const gpuNote = gpuFallbackNote(state);
  const threadsNote = threadNote(state);
  switch (state.status) {
    case "loading-model": {
      const pct = state.modelLoadProgress && state.modelLoadProgress.progress;
      return typeof pct === "number"
        ? `Loading Kokoro model… ${Math.round(pct)}%`
        : "Loading Kokoro model…";
    }
    case "synthesizing":
      return `Synthesizing…${gpuNote}${threadsNote}`;
    case "playing":
      return (state.progress.segmentCount > 1
        ? `Reading ${state.progress.segmentIndex + 1} / ${state.progress.segmentCount}`
        : "Reading…") + gpuNote + threadsNote;
    case "paused":
      return "Paused";
    case "error":
      return state.errorMessage || "Error";
    default:
      return "";
  }
}

function updateUI(state) {
  lastStatus = state.status;

  if (state.status === "idle") {
    closeAll();
    return;
  }

  const label = statusLabel(state);
  const toggleGlyph = state.status === "paused" ? "▶" : "❚❚";

  if (overlayEls) {
    overlayEls.statusEl.textContent = label;
    overlayEls.toggleBtn.textContent = toggleGlyph;
    overlayEls.toggleBtn.title = state.status === "paused" ? "Resume" : "Pause";
    if (state.currentSegmentId) {
      for (const el of overlayEls.segmentEls.values()) {
        el.classList.remove(HIGHLIGHT_CLASS);
      }
      const current = overlayEls.segmentEls.get(state.currentSegmentId);
      if (current) {
        current.classList.add(HIGHLIGHT_CLASS);
        if (!minimized) current.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  }

  if (miniPlayerEls) {
    miniPlayerEls.statusEl.textContent = label || "Kokoro Reader";
    miniPlayerEls.toggleBtn.textContent = toggleGlyph;
    miniPlayerEls.toggleBtn.title = state.status === "paused" ? "Resume" : "Pause";
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
    case "showOverlay":
      showOverlay(msg.title, msg.segments);
      return undefined;
    case "showMiniPlayer":
      showMiniPlayer();
      return undefined;
    case "closeOverlay":
      closeAll();
      return undefined;
    case "state":
      updateUI(msg.state);
      return undefined;
    default:
      return undefined;
  }
});
