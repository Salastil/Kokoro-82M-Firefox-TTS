"""Model loading and synthesis via the official `kokoro` PyPI package
(PyTorch-based). CPU only, deliberately -- GPU support (CUDA/ROCm) was
removed because it wasn't worth maintaining across two vendors nobody
here could actually test against; see the README's "GPU acceleration"
history note.
"""
import torch
from kokoro import KPipeline

MODEL_ID = "hexgrad/Kokoro-82M"
SAMPLE_RATE = 24000


class ModelState:
    def __init__(self):
        self.status = "loading"  # loading | ready | error
        self.error = None
        self.pipelines = {}  # lang_code -> KPipeline


def voice_lang_code(voice: str) -> str:
    # af_*/am_* = American English ('a'), bf_*/bm_* = British English ('b').
    return "b" if voice.startswith("b") else "a"


def load_model(state: ModelState):
    try:
        print(f"[kokoro] loading model ({MODEL_ID})...")
        pipeline_a = KPipeline(lang_code="a", device="cpu")
        # Reuse the already-loaded weights for the British English
        # pipeline instead of downloading/loading them a second time.
        pipeline_b = KPipeline(lang_code="b", model=pipeline_a.model)
        state.pipelines = {"a": pipeline_a, "b": pipeline_b}

        state.status = "ready"
        print("[kokoro] model ready (device=cpu)")
    except Exception as err:  # noqa: BLE001 -- surfaced via /health, want any failure caught
        state.status = "error"
        state.error = str(err)
        print(f"[kokoro] failed to load model: {err}")


def synthesize(state: ModelState, text: str, voice: str, speed: float):
    lang = voice_lang_code(voice)
    pipeline = state.pipelines.get(lang) or state.pipelines["a"]

    chunks = []
    for result in pipeline(text, voice=voice, speed=speed, split_pattern=None):
        if result.audio is not None:
            chunks.append(result.audio)

    if not chunks:
        raise RuntimeError("No audio produced for this text.")

    audio = torch.cat(chunks) if len(chunks) > 1 else chunks[0]
    return audio.detach().cpu().numpy()
