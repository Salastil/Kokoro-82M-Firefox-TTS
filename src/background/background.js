// Background service worker (Chrome/Brave) / event page (Firefox).
// Deliberately has no DOM dependency at all -- it never plays audio
// itself. It orchestrates: context menus, talking to the companion
// TTS server, and messaging chunks of synthesized audio out to the
// content script of the tab that's reading, which owns actual
// playback (a real page document, unlike this context, exists in
// both engines).
import browser from "webextension-polyfill";
import { KOKORO_VOICES, DEFAULT_SETTINGS, STORAGE_KEY } from "../common/constants.js";

// --- settings ------------------------------------------------------------

async function getSettings() {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEY] || {}) };
}

async function saveSettings(partial) {
  const current = await getSettings();
  const merged = { ...current, ...partial };
  await browser.storage.local.set({ [STORAGE_KEY]: merged });
  return merged;
}

// --- companion server client ----------------------------------------------

async function serverRequest(path, { method = "GET", body } = {}) {
  const settings = await getSettings();
  if (!settings.serverUrl) {
    throw new Error("No companion server URL configured. Set one in Settings.");
  }
  const url = settings.serverUrl.replace(/\/+$/, "") + path;

  let resp;
  try {
    resp = await fetch(url, {
      method,
      headers: {
        ...(settings.serverToken ? { Authorization: `Bearer ${settings.serverToken}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`Could not reach the companion server at ${settings.serverUrl}. Is it running?`);
  }

  if (resp.status === 401) {
    throw new Error("Companion server rejected the auth token -- check Settings.");
  }
  if (!resp.ok) {
    let message = `Server error (${resp.status})`;
    try {
      const data = await resp.json();
      if (data && data.error) message = data.error;
    } catch {
      // ignore, use the generic message
    }
    throw new Error(message);
  }
  return resp;
}

async function checkServerHealth() {
  const resp = await serverRequest("/health");
  return resp.json();
}

async function synthesizeChunk(text, { voice, speed }) {
  const resp = await serverRequest("/synthesize", {
    method: "POST",
    body: { text, voice, speed },
  });
  return resp.arrayBuffer();
}

// --- text chunking ---------------------------------------------------------
// Same idea as before: split into sentence-ish pieces so requests
// aren't too short (choppy) or too long (worse latency-to-first-audio).
function splitSentences(text) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const parts = normalized.match(/[^.!?]+[.!?]*(\s+|$)/g);
  return parts ? parts.map((s) => s.trim()).filter(Boolean) : [normalized];
}

function chunkText(text, maxChars) {
  const sentences = splitSentences(text);
  const chunks = [];
  let buf = "";
  for (const sentence of sentences) {
    const candidate = buf ? `${buf} ${sentence}` : sentence;
    if (buf && candidate.length > maxChars) {
      chunks.push(buf);
      buf = sentence;
    } else {
      buf = candidate;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

// --- job orchestration -------------------------------------------------

let jobCounter = 0;
let activeJobId = null;
let currentSegments = null;

const state = {
  status: "idle", // idle | connecting | synthesizing | playing | paused | error
  mode: null, // "selection" | "page" | null
  tabId: null,
  title: null,
  currentSegmentId: null,
  progress: { segmentIndex: 0, segmentCount: 0 },
  errorMessage: null,
  serverDevice: null, // "cuda" | "cpu" | null -- last known, from /health
};

function resetState() {
  state.status = "idle";
  state.mode = null;
  state.tabId = null;
  state.title = null;
  state.currentSegmentId = null;
  state.progress = { segmentIndex: 0, segmentCount: 0 };
  state.errorMessage = null;
}

function broadcastState() {
  browser.runtime.sendMessage({ type: "state", state }).catch(() => {});
  browser.action.setBadgeText({
    text: state.status === "playing" ? "▶" : state.status === "paused" ? "❚❚" : "",
  });
}

function failJob(jobId, message) {
  if (jobId !== activeJobId) return;
  state.status = "error";
  state.errorMessage = message;
  broadcastState();
  const tabId = state.tabId;
  activeJobId = null;
  if (tabId != null) {
    browser.tabs.sendMessage(tabId, { type: "stopReading", jobId, reason: "error" }).catch(() => {});
  }
}

async function startJob({ tabId, mode, title, segments }) {
  // Cancel anything in progress first.
  if (activeJobId != null && state.tabId != null) {
    browser.tabs.sendMessage(state.tabId, { type: "stopReading", jobId: activeJobId, reason: "restart" }).catch(() => {});
  }

  const jobId = ++jobCounter;
  activeJobId = jobId;
  currentSegments = segments;

  const settings = await getSettings();

  state.status = "connecting";
  state.mode = mode;
  state.tabId = tabId;
  state.title = title || null;
  state.currentSegmentId = null;
  state.progress = { segmentIndex: 0, segmentCount: segments.length };
  state.errorMessage = null;
  broadcastState();

  await browser.tabs
    .sendMessage(tabId, { type: "startReading", jobId, mode, title, segments })
    .catch(() => {});

  let health;
  try {
    health = await checkServerHealth();
  } catch (err) {
    failJob(jobId, err.message);
    return;
  }
  if (jobId !== activeJobId) return;
  state.serverDevice = health.device || null;
  if (health.status !== "ready") {
    failJob(jobId, health.error || `Companion server model isn't ready yet (${health.status}).`);
    return;
  }

  state.status = "synthesizing";
  broadcastState();

  const chunks = [];
  segments.forEach((segment, segmentIndex) => {
    for (const text of chunkText(segment.text, settings.chunkChars)) {
      chunks.push({ text, segmentId: segment.id, segmentIndex });
    }
  });

  for (let i = 0; i < chunks.length; i++) {
    if (jobId !== activeJobId) return;
    const chunk = chunks[i];
    let buffer;
    try {
      buffer = await synthesizeChunk(chunk.text, { voice: settings.voice, speed: settings.speed });
    } catch (err) {
      failJob(jobId, err.message);
      return;
    }
    if (jobId !== activeJobId) return;
    await browser.tabs
      .sendMessage(tabId, {
        type: "audioChunk",
        jobId,
        segmentId: chunk.segmentId,
        segmentIndex: chunk.segmentIndex,
        isLastChunk: i === chunks.length - 1,
        buffer,
      })
      .catch(() => {});
  }
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

function stopJob() {
  const tabId = state.tabId;
  const jobId = activeJobId;
  activeJobId = null;
  resetState();
  broadcastState();
  if (tabId != null) {
    browser.tabs.sendMessage(tabId, { type: "stopReading", jobId, reason: "user" }).catch(() => {});
  }
}

function pauseJob() {
  if (state.tabId == null) return;
  browser.tabs.sendMessage(state.tabId, { type: "pauseReading" }).catch(() => {});
  state.status = "paused";
  broadcastState();
}

function resumeJob() {
  if (state.tabId == null) return;
  browser.tabs.sendMessage(state.tabId, { type: "resumeReading" }).catch(() => {});
  state.status = "playing";
  broadcastState();
}

// Events reported by the content script that actually owns playback.
function onContentEvent(msg) {
  if (msg.jobId !== activeJobId) return; // stale job, ignore
  switch (msg.kind) {
    case "segmentStarted":
      state.status = "playing";
      state.currentSegmentId = msg.segmentId;
      state.progress.segmentIndex = msg.segmentIndex;
      broadcastState();
      break;
    case "buffering":
      state.status = "synthesizing";
      broadcastState();
      break;
    case "allPlaybackDone":
      activeJobId = null;
      resetState();
      broadcastState();
      break;
    case "playbackError":
      failJob(msg.jobId, msg.message || "Playback failed.");
      break;
    case "userStopped":
      activeJobId = null;
      resetState();
      broadcastState();
      break;
    case "userPaused":
      state.status = "paused";
      broadcastState();
      break;
    case "userResumed":
      state.status = "playing";
      broadcastState();
      break;
    default:
      break;
  }
}

// --- reading entry points --------------------------------------------------

async function getActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function ensureContentScript(tabId) {
  try {
    await browser.tabs.sendMessage(tabId, { type: "ping" });
  } catch {
    await browser.scripting.executeScript({ target: { tabId }, files: ["content/content.bundle.js"] });
    await browser.scripting.insertCSS({ target: { tabId }, files: ["content/content.css"] });
  }
}

async function readSelectionFromTab(tab, selectionTextFromMenu) {
  let text = selectionTextFromMenu;
  if (!text) {
    try {
      const resp = await browser.tabs.sendMessage(tab.id, { type: "getSelectionText" });
      text = resp && resp.text;
    } catch {
      // content script not present (e.g. privileged page) -- falls through to the error below
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
  await startJob({ tabId: tab.id, mode: "selection", title: null, segments: [{ id: "selection", text }] });
}

async function readArticleFromTab(tab) {
  await ensureContentScript(tab.id);
  let article;
  try {
    article = await browser.tabs.sendMessage(tab.id, { type: "extractArticle" });
  } catch {
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
  await startJob({ tabId: tab.id, mode: "page", title: article.title, segments: article.segments });
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

browser.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case "getState":
      return Promise.resolve({ state, voices: KOKORO_VOICES });
    case "getSettings":
      return getSettings();
    case "saveSettings":
      return saveSettings(msg.settings).then((settings) => ({ ok: true, settings }));
    case "checkServerHealth":
      return checkServerHealth()
        .then((health) => ({ ok: true, health }))
        .catch((err) => ({ ok: false, error: err.message }));
    case "readSelection":
      return getActiveTab().then((tab) => tab && readSelectionFromTab(tab));
    case "readPage":
      return getActiveTab().then((tab) => tab && readArticleFromTab(tab));
    case "pausePlayback":
      pauseJob();
      return Promise.resolve();
    case "resumePlayback":
      resumeJob();
      return Promise.resolve();
    case "stopPlayback":
      stopJob();
      return Promise.resolve();
    case "seekSegment":
      return seekToSegment(msg.segmentId);
    case "contentEvent":
      onContentEvent(msg);
      return undefined;
    default:
      return undefined;
  }
});

browser.action.setBadgeBackgroundColor({ color: "#5b4b8a" });
