import asyncio
import io
from contextlib import asynccontextmanager

import soundfile as sf
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from .config import load_config
from .tts import MODEL_ID, SAMPLE_RATE, ModelState, load_model, synthesize

config, config_path, is_new = load_config()
state = ModelState()


@asynccontextmanager
async def lifespan(app: FastAPI):
    print(f"[server] config: {config_path}")
    if is_new:
        print("[server] generated a new auth token.")
    print(f"[server] auth token: {config.token}")
    print("[server] paste this into the extension's Settings > Companion server.")
    # Runs in a worker thread so /health can respond ("loading") while
    # the (possibly slow, first-run-downloads-weights) model load is
    # still in progress, instead of blocking startup entirely.
    asyncio.create_task(asyncio.to_thread(load_model, state))
    yield


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    # Match the extension's expected error shape: {"error": "..."}
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})


def require_auth(authorization: str = Header(default="")):
    token = authorization[7:] if authorization.startswith("Bearer ") else None
    if not token or token != config.token:
        raise HTTPException(status_code=401, detail="Unauthorized")


class SynthesizeRequest(BaseModel):
    text: str
    voice: str = "af_heart"
    speed: float = 1.0


@app.get("/health")
async def health(_: None = Depends(require_auth)):
    return {
        "status": state.status,
        "device": state.device,
        "gpuBackend": state.gpu_backend,
        "modelId": MODEL_ID,
        "error": state.error,
    }


@app.post("/synthesize")
async def synthesize_endpoint(body: SynthesizeRequest, _: None = Depends(require_auth)):
    if state.status != "ready":
        raise HTTPException(status_code=503, detail=f"Model not ready ({state.status})")

    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")
    if len(text) > 2000:
        raise HTTPException(status_code=400, detail="text too long (max 2000 chars per request)")
    speed = min(2.0, max(0.5, body.speed or 1.0))
    voice = body.voice or "af_heart"

    try:
        audio = await asyncio.to_thread(synthesize, state, text, voice, speed)
    except Exception as err:  # noqa: BLE001 -- surfaced to the client as a 500
        print(f"[server] synthesis error: {err}")
        raise HTTPException(status_code=500, detail=str(err) or "Synthesis failed")

    buf = io.BytesIO()
    sf.write(buf, audio, SAMPLE_RATE, format="WAV")
    return Response(
        content=buf.getvalue(),
        media_type="audio/wav",
        headers={"X-Sample-Rate": str(SAMPLE_RATE)},
    )


def main():
    import uvicorn

    uvicorn.run(app, host=config.host, port=config.port)


if __name__ == "__main__":
    main()
