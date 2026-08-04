// Persistent MV2 background page. Owns:
//  - the TTS Worker (model lives here, not in content scripts/popup)
//  - an <audio> element that actually plays synthesized chunks
//  - the context menu entries
//  - the small bit of shared state that the popup and the active
//    tab's content script both read via a "state" broadcast message
"use strict";

/* global browser, KOKORO_VOICES, DEFAULT_SETTINGS, STORAGE_KEY */

let worker = null;
let jobCounter = 0;
let activeJobId = null;

// The background page is a normal window/document context (unlike the
// TTS Worker), so this reflects whether Firefox exposes WebGPU *at
// all* in this profile/build. If this is true but the worker still
// falls back to CPU, the gap is specifically "WebGPU not available to
// Workers in this Firefox version" rather than "WebGPU unsupported
// here" -- useful for telling those two situations apart in the UI.
const GPU_AVAILABLE_IN_WINDOW = typeof navigator !== "undefined" && !!navigator.gpu;

// Same idea for cross-origin isolation (SharedArrayBuffer / WASM
// threading): checked here in the background *page* (a window
// context) so it can be compared against what the Worker reports.
// Spawning a Worker from an isolated page doesn't guarantee the
// Worker itself is isolated in every engine, so if this is true but
// the worker's crossOriginIsolated/wasmThreads come back false/1,
// that's specifically a Worker-inheritance gap, not a browser-wide
// "isolation unavailable" situation.
const WINDOW_CROSS_ORIGIN_ISOLATED =
  typeof self !== "undefined" && !!self.crossOriginIsolated && typeof SharedArrayBuffer !== "undefined";

const audioEl = new Audio();
audioEl.autoplay = false;

const queue = []; // { url, segmentId, isLastSegment }
let playingItem = null;
let jobDone = false;

const state = {
  status: "idle", // idle | loading-model | synthesizing | playing | paused | error
  mode: null, // "selection" | "page" | null
  tabId: null,
  title: null,
  currentSegmentId: null,
  progress: { segmentIndex: 0, segmentCount: 0 },
  modelLoadProgress: null,
  errorMessage: null,
  device: null, // "wasm" | "webgpu", set once the worker reports which it actually loaded on
  deviceFellBack: false, // true if webgpu was requested but unavailable, so wasm was used instead
  deviceFallbackReason: null, // "no-navigator-gpu" | "no-adapter" | "adapter-error" | null
  gpuAvailableInWindow: GPU_AVAILABLE_IN_WINDOW, // static fact about this Firefox profile, not job-scoped
  wasmThreads: null, // actual ONNX Runtime Web WASM thread count in use (device === "wasm")
  crossOriginIsolated: null, // whether the *worker* context could multithread WASM at all
  windowCrossOriginIsolated: WINDOW_CROSS_ORIGIN_ISOLATED, // same fact, but for the background page itself
};

function resetState() {
  state.status = "idle";
  state.mode = null;
  state.tabId = null;
  state.title = null;
  state.currentSegmentId = null;
  state.progress = { segmentIndex: 0, segmentCount: 0 };
  state.modelLoadProgress = null;
  state.errorMessage = null;
  state.device = null;
  state.deviceFellBack = false;
  state.deviceFallbackReason = null;
}

function broadcastState() {
  browser.runtime.sendMessage({ type: "state", state }).catch(() => {});
  if (state.tabId != null) {
    browser.tabs.sendMessage(state.tabId, { type: "state", state }).catch(() => {});
  }
  browser.browserAction.setBadgeText({
    text: state.status === "playing" ? "▶" : state.status === "paused" ? "❚❚" : "",
  });
}

async function getSettings() {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEY] || {}) };
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(browser.runtime.getURL("worker/tts-worker.bundle.js"), {
    type: "module",
  });
  worker.onmessage = onWorkerMessage;
  worker.onerror = (err) => {
    state.status = "error";
    state.errorMessage = err.message || "Worker crashed";
    broadcastState();
  };
  return worker;
}

function onWorkerMessage(event) {
  const msg = event.data;
  if (msg.type === "workerStarted") return;

  if (msg.jobId !== activeJobId) return; // stale job, ignore

  switch (msg.type) {
    case "progress":
      state.modelLoadProgress = msg.progress;
      state.status = "loading-model";
      broadcastState();
      break;
    case "ready":
      state.status = "synthesizing";
      state.modelLoadProgress = null;
      state.device = msg.device;
      state.deviceFellBack = !!msg.fellBack;
      state.deviceFallbackReason = msg.reason || null;
      state.wasmThreads = msg.wasmThreads ?? null;
      state.crossOriginIsolated = !!msg.crossOriginIsolated;
      broadcastState();
      break;
    case "audio": {
      const url = URL.createObjectURL(new Blob([msg.buffer], { type: "audio/wav" }));
      queue.push({
        url,
        segmentId: msg.segmentId,
        segmentIndex: msg.segmentIndex,
        isLastSegment: msg.isLastSegment,
      });
      maybeStartPlayback();
      break;
    }
    case "done":
      jobDone = true;
      break;
    case "error":
      state.status = "error";
      state.errorMessage = msg.message;
      broadcastState();
      stopPlayback({ keepError: true });
      break;
    default:
      break;
  }
}

function maybeStartPlayback() {
  if (playingItem || queue.length === 0) return;
  if (state.status === "paused") return;
  playingItem = queue.shift();
  if (state.currentSegmentId !== playingItem.segmentId) {
    state.currentSegmentId = playingItem.segmentId;
    state.progress.segmentIndex = playingItem.segmentIndex;
  }
  audioEl.src = playingItem.url;
  state.status = "playing";
  broadcastState();
  audioEl.play().catch((err) => {
    state.status = "error";
    state.errorMessage = `Playback failed: ${err.message}`;
    broadcastState();
  });
}

audioEl.addEventListener("ended", () => {
  if (playingItem) {
    URL.revokeObjectURL(playingItem.url);
    const wasLast = playingItem.isLastSegment;
    playingItem = null;
    if (wasLast && queue.length === 0 && jobDone) {
      finishPlayback();
      return;
    }
  }
  maybeStartPlayback();
  if (!playingItem && queue.length === 0 && !jobDone) {
    // Caught up with the model; wait for more chunks to arrive.
    state.status = "synthesizing";
    broadcastState();
  }
});

function finishPlayback() {
  const finishedTabId = state.tabId;
  worker && worker.postMessage({ type: "stop" });
  activeJobId = null;
  clearQueue();
  resetState();
  broadcastState();
  if (finishedTabId != null) {
    browser.tabs.sendMessage(finishedTabId, { type: "closeOverlay" }).catch(() => {});
  }
}

function clearQueue() {
  for (const item of queue) URL.revokeObjectURL(item.url);
  queue.length = 0;
  if (playingItem) {
    URL.revokeObjectURL(playingItem.url);
    playingItem = null;
  }
  jobDone = false;
}

function stopPlayback({ keepError = false } = {}) {
  const stoppedTabId = state.tabId;
  audioEl.pause();
  audioEl.removeAttribute("src");
  clearQueue();
  if (worker) worker.postMessage({ type: "stop" });
  activeJobId = null;
  const errorMessage = keepError ? state.errorMessage : null;
  const status = keepError ? "error" : "idle";
  resetState();
  state.status = status;
  state.errorMessage = errorMessage;
  broadcastState();
  if (stoppedTabId != null) {
    browser.tabs.sendMessage(stoppedTabId, { type: "closeOverlay" }).catch(() => {});
  }
}

function pausePlayback() {
  audioEl.pause();
  state.status = "paused";
  broadcastState();
}

function resumePlayback() {
  if (state.status !== "paused") return;
  if (audioEl.src) {
    state.status = "playing";
    broadcastState();
    audioEl.play().catch(() => {});
  } else {
    maybeStartPlayback();
  }
}

let currentSegments = null;

async function startJob({ tabId, mode, title, segments }) {
  stopPlayback(); // cancel anything in progress
  const settings = await getSettings();

  currentSegments = segments;
  activeJobId = ++jobCounter;
  state.status = "loading-model";
  state.mode = mode;
  state.tabId = tabId;
  state.title = title || null;
  state.progress = { segmentIndex: 0, segmentCount: segments.length };
  broadcastState();

  ensureWorker().postMessage({
    type: "speak",
    jobId: activeJobId,
    segments,
    options: {
      voice: settings.voice,
      speed: settings.speed,
      dtype: settings.dtype,
      chunkChars: settings.chunkChars,
      device: settings.device,
    },
  });
}

async function seekToSegment(segmentId) {
  if (!currentSegments || state.tabId == null) return;
  const idx = currentSegments.findIndex((s) => s.id === segmentId);
  if (idx === -1) return;
  await startJob({
    tabId: state.tabId,
    mode: state.mode,
    title: state.title,
    segments: currentSegments.slice(idx),
  });
}

async function getActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function readSelectionFromTab(tab, selectionTextFromMenu) {
  let text = selectionTextFromMenu;
  if (!text) {
    try {
      const resp = await browser.tabs.sendMessage(tab.id, { type: "getSelectionText" });
      text = resp && resp.text;
    } catch {
      // content script not present (e.g. privileged page) -- fall through to error below
    }
  }
  text = (text || "").trim();
  if (!text) {
    state.status = "error";
    state.errorMessage = "No text selected.";
    broadcastState();
    return;
  }
  await ensureContentScript(tab.id);
  await browser.tabs.sendMessage(tab.id, { type: "showMiniPlayer" }).catch(() => {});
  await startJob({
    tabId: tab.id,
    mode: "selection",
    title: null,
    segments: [{ id: "selection", text }],
  });
}

async function readArticleFromTab(tab) {
  await ensureContentScript(tab.id);
  let article;
  try {
    article = await browser.tabs.sendMessage(tab.id, { type: "extractArticle" });
  } catch (err) {
    state.status = "error";
    state.errorMessage = "Could not read this page.";
    broadcastState();
    return;
  }
  if (!article || !article.segments || article.segments.length === 0) {
    state.status = "error";
    state.errorMessage = "Couldn't find readable article content on this page.";
    broadcastState();
    return;
  }
  await browser.tabs
    .sendMessage(tab.id, {
      type: "showOverlay",
      title: article.title,
      segments: article.segments,
    })
    .catch(() => {});
  await startJob({
    tabId: tab.id,
    mode: "page",
    title: article.title,
    segments: article.segments,
  });
}

async function ensureContentScript(tabId) {
  try {
    await browser.tabs.sendMessage(tabId, { type: "ping" });
  } catch {
    await browser.tabs.executeScript(tabId, { file: "content/content.bundle.js" });
    await browser.tabs.insertCSS(tabId, { file: "content/content.css" });
  }
}

// --- context menus -----------------------------------------------------

browser.contextMenus.create({
  id: "kokoro-read-selection",
  title: "Read selection aloud (Kokoro)",
  contexts: ["selection"],
});
browser.contextMenus.create({
  id: "kokoro-read-page",
  title: "Read article aloud (Kokoro)",
  contexts: ["page"],
});

browser.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  if (info.menuItemId === "kokoro-read-selection") {
    readSelectionFromTab(tab, info.selectionText);
  } else if (info.menuItemId === "kokoro-read-page") {
    readArticleFromTab(tab);
  }
});

// --- message router ------------------------------------------------------

browser.runtime.onMessage.addListener((msg, sender) => {
  switch (msg.type) {
    case "getState":
      return Promise.resolve({ state, voices: KOKORO_VOICES });
    case "getSettings":
      return getSettings();
    case "saveSettings":
      return getSettings().then((current) => {
        const merged = { ...current, ...msg.settings };
        return browser.storage.local
          .set({ [STORAGE_KEY]: merged })
          .then(() => ({ ok: true, settings: merged }));
      });
    case "readSelection":
      return getActiveTab().then((tab) => tab && readSelectionFromTab(tab));
    case "readPage":
      return getActiveTab().then((tab) => tab && readArticleFromTab(tab));
    case "readSelectionInTab":
      // from content script's own floating toolbar, if used
      return sender.tab && readSelectionFromTab(sender.tab, msg.text);
    case "pausePlayback":
      pausePlayback();
      return Promise.resolve();
    case "resumePlayback":
      resumePlayback();
      return Promise.resolve();
    case "stopPlayback":
      stopPlayback();
      return Promise.resolve();
    case "seekSegment":
      return seekToSegment(msg.segmentId);
    default:
      return undefined;
  }
});

browser.browserAction.setBadgeBackgroundColor({ color: "#5b4b8a" });
