// Model loading with automatic device fallback. Tries CUDA first (the
// only GPU execution provider onnxruntime-node ships prebuilt on
// Linux -- no ROCm/ MIGraphX, so AMD GPUs fall straight through to
// CPU here, same outcome as CPU-only but still worth trying since it
// costs nothing on hardware where it does work).
import { KokoroTTS } from "kokoro-js";

export const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

const DEVICE_ATTEMPTS = ["cuda", "cpu"];

export async function loadModel(dtype, { onProgress } = {}) {
  let lastErr;
  for (const device of DEVICE_ATTEMPTS) {
    try {
      console.log(`[kokoro] loading model (dtype=${dtype}, device=${device})...`);
      const tts = await KokoroTTS.from_pretrained(MODEL_ID, {
        dtype,
        device,
        progress_callback: onProgress,
      });
      console.log(`[kokoro] model ready on ${device}.`);
      return { tts, device };
    } catch (err) {
      lastErr = err;
      console.warn(`[kokoro] device "${device}" unavailable: ${err.message}`);
    }
  }
  throw lastErr;
}
