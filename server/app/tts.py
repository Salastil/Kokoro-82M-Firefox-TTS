"""Model loading and synthesis via the official `kokoro` PyPI package
(PyTorch-based). Device selection is delegated entirely to PyTorch:
device=None auto-selects the "cuda" device if torch.cuda.is_available(),
which is also true on AMD GPUs when a ROCm-flavored torch build is
installed -- ROCm's whole design is that `torch.cuda` transparently
maps onto HIP/ROCm, so no AMD-specific code is needed here at all.
Falls back to CPU automatically otherwise.
"""
import torch
from kokoro import KPipeline

MODEL_ID = "hexgrad/Kokoro-82M"
SAMPLE_RATE = 24000


class ModelState:
    def __init__(self):
        self.status = "loading"  # loading | ready | error
        self.device = None  # "cuda" | "cpu" | None
        self.gpu_backend = None  # "rocm" | "cuda" | None
        self.error = None
        self.pipelines = {}  # lang_code -> KPipeline


def voice_lang_code(voice: str) -> str:
    # af_*/am_* = American English ('a'), bf_*/bm_* = British English ('b').
    return "b" if voice.startswith("b") else "a"


def load_model(state: ModelState):
    try:
        print(f"[kokoro] loading model ({MODEL_ID})...")
        pipeline_a = KPipeline(lang_code="a", device=None)
        # Reuse the already-loaded weights for the British English
        # pipeline instead of downloading/loading them a second time.
        pipeline_b = KPipeline(lang_code="b", model=pipeline_a.model)
        state.pipelines = {"a": pipeline_a, "b": pipeline_b}

        if torch.cuda.is_available():
            state.device = "cuda"
            state.gpu_backend = "rocm" if getattr(torch.version, "hip", None) else "cuda"
        else:
            state.device = "cpu"
            state.gpu_backend = None

        state.status = "ready"
        print(f"[kokoro] model ready (device={state.device}, backend={state.gpu_backend or 'none'})")
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
