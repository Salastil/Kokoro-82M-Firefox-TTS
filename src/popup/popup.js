import browser from "webextension-polyfill";
import { KOKORO_VOICES } from "../common/constants.js";

const statusEl = document.getElementById("status");
const errorBanner = document.getElementById("errorBanner");
const readSelectionBtn = document.getElementById("readSelectionBtn");
const readPageBtn = document.getElementById("readPageBtn");
const playbackControls = document.getElementById("playbackControls");
const toggleBtn = document.getElementById("toggleBtn");
const stopBtn = document.getElementById("stopBtn");
const voiceSelect = document.getElementById("voiceSelect");
const speedRange = document.getElementById("speedRange");
const speedValue = document.getElementById("speedValue");
const openOptions = document.getElementById("openOptions");

let lastStatus = "idle";

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

function deviceNote(state) {
  if (!state.serverDevice) return "";
  if (state.serverDevice !== "cuda") return " · server CPU";
  return state.serverGpuBackend === "rocm" ? " · server GPU (ROCm)" : " · server GPU (CUDA)";
}

function statusLabel(state) {
  switch (state.status) {
    case "connecting":
      return "Connecting to companion server…";
    case "synthesizing":
      return `Synthesizing…${deviceNote(state)}`;
    case "playing":
      return (
        (state.progress.segmentCount > 1
          ? `Reading paragraph ${state.progress.segmentIndex + 1} of ${state.progress.segmentCount}`
          : "Reading…") + deviceNote(state)
      );
    case "paused":
      return "Paused";
    case "error":
      return "Error";
    default:
      return "Idle";
  }
}

function render(state) {
  lastStatus = state.status;
  statusEl.textContent = statusLabel(state);

  const active = state.status !== "idle" && state.status !== "error";
  playbackControls.hidden = !active;
  toggleBtn.textContent = state.status === "paused" ? "Resume" : "Pause";

  if (state.status === "error" && state.errorMessage) {
    errorBanner.hidden = false;
    errorBanner.textContent = state.errorMessage;
  } else {
    errorBanner.hidden = true;
  }
}

async function refreshState() {
  const resp = await browser.runtime.sendMessage({ type: "getState" });
  if (resp) render(resp.state);
}

async function loadSettings() {
  const settings = await browser.runtime.sendMessage({ type: "getSettings" });
  populateVoices(settings.voice);
  speedRange.value = String(settings.speed);
  speedValue.textContent = `${Number(settings.speed).toFixed(1)}x`;
}

function saveSettings(partial) {
  return browser.runtime.sendMessage({ type: "saveSettings", settings: partial });
}

readSelectionBtn.addEventListener("click", () => {
  browser.runtime.sendMessage({ type: "readSelection" });
  window.close();
});

readPageBtn.addEventListener("click", () => {
  browser.runtime.sendMessage({ type: "readPage" });
  window.close();
});

toggleBtn.addEventListener("click", () => {
  browser.runtime.sendMessage({
    type: lastStatus === "paused" ? "resumePlayback" : "pausePlayback",
  });
});

stopBtn.addEventListener("click", () => {
  browser.runtime.sendMessage({ type: "stopPlayback" });
});

voiceSelect.addEventListener("change", () => {
  saveSettings({ voice: voiceSelect.value });
});

speedRange.addEventListener("input", () => {
  speedValue.textContent = `${Number(speedRange.value).toFixed(1)}x`;
});

speedRange.addEventListener("change", () => {
  saveSettings({ speed: Number(speedRange.value) });
});

openOptions.addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});

browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === "state") render(msg.state);
});

loadSettings();
refreshState();
