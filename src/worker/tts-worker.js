// Runs inside a dedicated module Worker spawned by the background
// page. Owns the Kokoro-82M model and does all synthesis here so the
// (CPU-heavy) inference never blocks the background page's event loop
// or the popup/content-script UI.
//
// CPU (`device: "wasm"`) is the default and always the fallback. GPU
// acceleration via WebGPU is opt-in (Settings > Performance) and is
// only ever used if the browser actually reports WebGPU support --
// otherwise resolveDevice() below silently downgrades to "wasm".
import { KokoroTTS, env as kokoroEnv } from "kokoro-js";
import { env } from "@huggingface/transformers";

// Point onnxruntime-web at the WASM runtime vendored inside the
// extension (extension/runtime/) instead of the library's default
// (a jsdelivr CDN fetch). This keeps all *executable* code local, per
// Firefox add-on policy -- only model *weights* (data, not code) are
// fetched remotely, from Hugging Face.
kokoroEnv.wasmPaths = new URL("../runtime/", import.meta.url).href;

env.allowLocalModels = false;
env.useBrowserCache = true;

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

// Firefox's WebGPU support is inconsistent across contexts/platforms:
// `navigator.gpu` may simply not exist here (WebGPU disabled, or not
// yet exposed to dedicated Workers at all in this Firefox version --
// a known gap, separate from main-thread support), or it may exist
// but fail to hand back a usable adapter (no compatible GPU/driver).
// Actually requesting an adapter (not just checking `navigator.gpu`
// truthiness) distinguishes those cases so the UI can say something
// more useful than a bare "unavailable".
async function resolveDevice(requested) {
  if (requested !== "webgpu") return { device: "wasm", fellBack: false, reason: null };

  if (typeof navigator === "undefined" || !navigator.gpu) {
    return { device: "wasm", fellBack: true, reason: "no-navigator-gpu" };
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { device: "wasm", fellBack: true, reason: "no-adapter" };
    return { device: "webgpu", fellBack: false, reason: null };
  } catch {
    return { device: "wasm", fellBack: true, reason: "adapter-error" };
  }
}

let ttsPromise = null;
let loadedDtype = null;
let loadedDevice = null;

function loadTTS(dtype, device) {
  if (ttsPromise && loadedDtype === dtype && loadedDevice === device) return ttsPromise;
  loadedDtype = dtype;
  loadedDevice = device;
  ttsPromise = KokoroTTS.from_pretrained(MODEL_ID, {
    dtype,
    device,
    progress_callback: (progress) => {
      postMessage({ type: "progress", progress });
    },
  }).catch((err) => {
    ttsPromise = null;
    loadedDtype = null;
    loadedDevice = null;
    throw err;
  });
  return ttsPromise;
}

// --- text chunking ---------------------------------------------------
// Kokoro sounds best on a sentence or two at a time. Split into
// sentence-ish pieces, then pack consecutive sentences into chunks up
// to `maxChars` so requests aren't too short (choppy) or too long
// (worse quality / latency).
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

// --- job control -------------------------------------------------------
// Only one "speak" job is ever active. A new "speak" or a "stop"
// message invalidates the previous jobId, so in-flight async work
// checks jobId === activeJobId before posting each result and bails
// out silently otherwise.
let activeJobId = null;

async function runJob(jobId, segments, options) {
  const { voice, speed, dtype, chunkChars, device: requestedDevice } = options;
  const { device, fellBack, reason } = await resolveDevice(requestedDevice);
  let tts;
  try {
    tts = await loadTTS(dtype, device);
  } catch (err) {
    if (jobId === activeJobId) {
      postMessage({
        type: "error",
        jobId,
        message: `Failed to load Kokoro model: ${err?.message || err}`,
      });
    }
    return;
  }
  if (jobId !== activeJobId) return;
  postMessage({ type: "ready", jobId, device, requestedDevice, fellBack, reason });

  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    if (jobId !== activeJobId) return;
    const segment = segments[segIdx];
    const chunks = chunkText(segment.text, chunkChars);
    if (chunks.length === 0) continue;

    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
      if (jobId !== activeJobId) return;
      const text = chunks[chunkIdx];
      let audio;
      try {
        audio = await tts.generate(text, { voice, speed });
      } catch (err) {
        if (jobId === activeJobId) {
          postMessage({
            type: "error",
            jobId,
            message: `Synthesis failed: ${err?.message || err}`,
          });
        }
        return;
      }
      if (jobId !== activeJobId) return;

      const arrayBuffer = await audio.toBlob().arrayBuffer();
      postMessage(
        {
          type: "audio",
          jobId,
          segmentIndex: segIdx,
          segmentId: segment.id ?? null,
          chunkIndex: chunkIdx,
          chunkCount: chunks.length,
          isLastSegment: segIdx === segments.length - 1 && chunkIdx === chunks.length - 1,
          sampleRate: audio.sampling_rate,
          buffer: arrayBuffer,
        },
        [arrayBuffer]
      );
    }
  }

  if (jobId === activeJobId) {
    postMessage({ type: "done", jobId });
  }
}

self.onmessage = (event) => {
  const msg = event.data;
  switch (msg.type) {
    case "speak":
      activeJobId = msg.jobId;
      runJob(msg.jobId, msg.segments, msg.options).catch((err) => {
        if (msg.jobId === activeJobId) {
          postMessage({
            type: "error",
            jobId: msg.jobId,
            message: `Worker error: ${err?.message || err}`,
          });
        }
      });
      break;
    case "stop":
      activeJobId = null;
      break;
    case "warm":
      resolveDevice(msg.device)
        .then(({ device }) => loadTTS(msg.dtype || "q8", device))
        .catch((err) => {
          postMessage({
            type: "error",
            jobId: null,
            message: `Model load failed: ${err?.message || err}`,
          });
        });
      break;
    default:
      break;
  }
};

postMessage({ type: "workerStarted" });
