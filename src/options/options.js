import browser from "webextension-polyfill";
import { KOKORO_VOICES } from "../common/constants.js";

const serverUrlInput = document.getElementById("serverUrl");
const serverTokenInput = document.getElementById("serverToken");
const testConnectionBtn = document.getElementById("testConnection");
const connectionStatus = document.getElementById("connectionStatus");
const voiceSelect = document.getElementById("voiceSelect");
const speedRange = document.getElementById("speedRange");
const speedValue = document.getElementById("speedValue");
const volumeRange = document.getElementById("volumeRange");
const volumeValue = document.getElementById("volumeValue");
const chunkCharsInput = document.getElementById("chunkChars");
const savedNote = document.getElementById("savedNote");
const logPane = document.getElementById("logPane");
const logLevelFilter = document.getElementById("logLevelFilter");
const copyLogsBtn = document.getElementById("copyLogs");
const clearLogsBtn = document.getElementById("clearLogs");

function populateVoices(selected) {
  voiceSelect.innerHTML = "";
  for (const v of KOKORO_VOICES) {
    const opt = document.createElement("option");
    opt.value = v.id;
    opt.textContent = v.label;
    voiceSelect.appendChild(opt);
  }
  voiceSelect.value = selected;
}

async function loadSettings() {
  const settings = await browser.runtime.sendMessage({ type: "getSettings" });
  serverUrlInput.value = settings.serverUrl;
  serverTokenInput.value = settings.serverToken;
  populateVoices(settings.voice);
  speedRange.value = String(settings.speed);
  speedValue.textContent = `${Number(settings.speed).toFixed(1)}x`;
  volumeRange.value = String(settings.volume);
  volumeValue.textContent = `${Math.round(Number(settings.volume) * 100)}%`;
  chunkCharsInput.value = String(settings.chunkChars);
}

let saveTimer = null;
function save(partial) {
  browser.runtime.sendMessage({ type: "saveSettings", settings: partial }).then(() => {
    savedNote.hidden = false;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      savedNote.hidden = true;
    }, 1200);
  });
}

function normalizeServerUrl(raw) {
  const trimmed = (raw || "").trim();
  if (!trimmed) return trimmed;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

serverUrlInput.addEventListener("change", () => {
  // Self-correct a bare "host:port" (missing http://) so the field
  // shows what's actually being used, not just what was typed.
  const normalized = normalizeServerUrl(serverUrlInput.value);
  serverUrlInput.value = normalized;
  save({ serverUrl: normalized });
});

serverTokenInput.addEventListener("change", () => {
  save({ serverToken: serverTokenInput.value.trim() });
});

testConnectionBtn.addEventListener("click", async () => {
  // Persist first so the background script's check uses what's on screen,
  // not a stale previously-saved value.
  const normalizedUrl = normalizeServerUrl(serverUrlInput.value);
  serverUrlInput.value = normalizedUrl;
  await browser.runtime.sendMessage({
    type: "saveSettings",
    settings: {
      serverUrl: normalizedUrl,
      serverToken: serverTokenInput.value.trim(),
    },
  });

  connectionStatus.textContent = "Checking…";
  const resp = await browser.runtime.sendMessage({ type: "checkServerHealth" });
  if (!resp || !resp.ok) {
    connectionStatus.textContent = `Connection failed: ${(resp && resp.error) || "unknown error"}`;
    return;
  }
  const health = resp.health;
  if (health.status === "ready") {
    const backend =
      health.device === "cuda"
        ? health.gpuBackend === "rocm"
          ? "GPU (ROCm)"
          : "GPU (CUDA)"
        : "CPU";
    connectionStatus.textContent = `Connected -- model ready on ${backend}.`;
  } else if (health.status === "loading") {
    connectionStatus.textContent = "Connected -- server is still loading the model, try again shortly.";
  } else {
    connectionStatus.textContent = `Connected, but server reports an error: ${health.error || "unknown"}`;
  }
});

voiceSelect.addEventListener("change", () => save({ voice: voiceSelect.value }));

speedRange.addEventListener("input", () => {
  speedValue.textContent = `${Number(speedRange.value).toFixed(1)}x`;
});
speedRange.addEventListener("change", () => save({ speed: Number(speedRange.value) }));

volumeRange.addEventListener("input", () => {
  volumeValue.textContent = `${Math.round(Number(volumeRange.value) * 100)}%`;
  save({ volume: Number(volumeRange.value) });
});

chunkCharsInput.addEventListener("change", () => {
  const val = Math.max(80, Math.min(800, Number(chunkCharsInput.value) || 400));
  chunkCharsInput.value = String(val);
  save({ chunkChars: val });
});

// --- diagnostics log ------------------------------------------------------

const LOG_LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 };
let logEntries = [];

function formatLogTime(ts) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString(undefined, { hour12: false });
  return `${time}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function formatLogEntry(entry) {
  const extra = entry.data ? ` ${JSON.stringify(entry.data)}` : "";
  return `[${formatLogTime(entry.ts)}] [${entry.source}] [${entry.level}] ${entry.message}${extra}`;
}

function renderLogs() {
  const minRank = LOG_LEVEL_RANK[logLevelFilter.value] ?? 1;
  // Only auto-scroll if the user was already at (or near) the bottom --
  // otherwise a live-updating pane yanks their scroll position away
  // right as they're trying to read something further up.
  const nearBottom = logPane.scrollHeight - logPane.scrollTop - logPane.clientHeight < 40;
  const visible = logEntries.filter((e) => (LOG_LEVEL_RANK[e.level] ?? 1) >= minRank);
  logPane.textContent = visible.map(formatLogEntry).join("\n");
  if (nearBottom) logPane.scrollTop = logPane.scrollHeight;
}

function appendLog(entry) {
  logEntries.push(entry);
  if (logEntries.length > 500) logEntries.shift();
  renderLogs();
}

browser.runtime.sendMessage({ type: "getLogs" }).then((resp) => {
  logEntries = (resp && resp.logs) || [];
  renderLogs();
});

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "logEntry") appendLog(msg.entry);
});

logLevelFilter.addEventListener("change", renderLogs);

clearLogsBtn.addEventListener("click", () => {
  browser.runtime.sendMessage({ type: "clearLogs" }).then(() => {
    logEntries = [];
    renderLogs();
  });
});

copyLogsBtn.addEventListener("click", async () => {
  const text = logEntries.map(formatLogEntry).join("\n");
  const original = copyLogsBtn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    copyLogsBtn.textContent = "Copied!";
  } catch {
    copyLogsBtn.textContent = "Copy failed";
  }
  setTimeout(() => {
    copyLogsBtn.textContent = original;
  }, 1200);
});

loadSettings();
