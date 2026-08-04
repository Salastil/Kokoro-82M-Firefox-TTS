"use strict";

/* global browser, KOKORO_VOICES */

const CACHE_NAMES = ["transformers-cache", "kokoro-voices"];

const voiceSelect = document.getElementById("voiceSelect");
const speedRange = document.getElementById("speedRange");
const speedValue = document.getElementById("speedValue");
const chunkCharsInput = document.getElementById("chunkChars");
const dtypeRadios = document.querySelectorAll('input[name="dtype"]');
const gpuCheckbox = document.getElementById("gpuCheckbox");
const gpuDetected = document.getElementById("gpuDetected");
const threadingDetected = document.getElementById("threadingDetected");
const clearCacheBtn = document.getElementById("clearCache");
const cacheStatus = document.getElementById("cacheStatus");
const savedNote = document.getElementById("savedNote");

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

function currentDtype() {
  for (const r of dtypeRadios) if (r.checked) return r.value;
  return "q8";
}

async function loadSettings() {
  const settings = await browser.runtime.sendMessage({ type: "getSettings" });
  populateVoices(settings.voice);
  speedRange.value = String(settings.speed);
  speedValue.textContent = `${Number(settings.speed).toFixed(1)}x`;
  chunkCharsInput.value = String(settings.chunkChars);
  for (const r of dtypeRadios) r.checked = r.value === settings.dtype;
  gpuCheckbox.checked = settings.device === "webgpu";
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

voiceSelect.addEventListener("change", () => save({ voice: voiceSelect.value }));

speedRange.addEventListener("input", () => {
  speedValue.textContent = `${Number(speedRange.value).toFixed(1)}x`;
});
speedRange.addEventListener("change", () => save({ speed: Number(speedRange.value) }));

chunkCharsInput.addEventListener("change", () => {
  const val = Math.max(80, Math.min(600, Number(chunkCharsInput.value) || 300));
  chunkCharsInput.value = String(val);
  save({ chunkChars: val });
});

for (const r of dtypeRadios) {
  r.addEventListener("change", () => save({ dtype: currentDtype() }));
}

gpuCheckbox.addEventListener("change", () => {
  save({ device: gpuCheckbox.checked ? "webgpu" : "wasm" });
});

async function refreshDiagnostics() {
  const resp = await browser.runtime.sendMessage({ type: "getState" });
  const state = resp && resp.state;
  if (!state) return;

  if (state.gpuAvailableInWindow) {
    gpuDetected.textContent =
      "Detected: WebGPU is available in this Firefox. Whether a read actually uses it " +
      "also depends on Firefox exposing WebGPU to background Workers, which lags behind " +
      "main-thread support -- if it isn't, reads will say so and use CPU automatically.";
  } else {
    gpuDetected.textContent =
      "Detected: WebGPU is not available in this Firefox/profile, so this toggle will " +
      "have no effect until it is. Check about:config -> dom.webgpu.enabled, or update Firefox.";
  }

  if (state.wasmThreads) {
    // A read has happened at least once, so we know what the Worker
    // actually got, not just what the background page can see.
    threadingDetected.textContent =
      state.wasmThreads > 1
        ? `Detected: last read used ${state.wasmThreads} CPU threads.`
        : `Detected: last read used only 1 CPU thread (background page itself is ` +
          `${state.windowCrossOriginIsolated ? "" : "not "}cross-origin isolated` +
          `${state.windowCrossOriginIsolated ? ", but the Worker isn't -- a Firefox Worker-isolation gap, not something this extension can force" : ""}).`;
  } else {
    threadingDetected.textContent = state.windowCrossOriginIsolated
      ? "Detected: this background page is cross-origin isolated. Read something once to see what the synthesis Worker actually gets (it doesn't always inherit this)."
      : "Detected: this background page is not cross-origin isolated, so the synthesis Worker almost certainly won't be either -- expect single-threaded CPU synthesis.";
  }
}

async function refreshCacheStatus() {
  if (!("caches" in window)) {
    cacheStatus.textContent = "Cache storage unavailable.";
    return;
  }
  let totalEntries = 0;
  let found = false;
  for (const name of CACHE_NAMES) {
    try {
      const has = await caches.has(name);
      if (!has) continue;
      found = true;
      const cache = await caches.open(name);
      const keys = await cache.keys();
      totalEntries += keys.length;
    } catch {
      // ignore
    }
  }
  cacheStatus.textContent = found
    ? `Model data is cached locally (${totalEntries} file${totalEntries === 1 ? "" : "s"}).`
    : "No model data cached yet -- it will download on first use.";
}

clearCacheBtn.addEventListener("click", async () => {
  clearCacheBtn.disabled = true;
  clearCacheBtn.textContent = "Clearing…";
  for (const name of CACHE_NAMES) {
    try {
      await caches.delete(name);
    } catch {
      // ignore
    }
  }
  clearCacheBtn.disabled = false;
  clearCacheBtn.textContent = "Clear cached model data";
  await refreshCacheStatus();
});

loadSettings();
refreshCacheStatus();
refreshDiagnostics();
