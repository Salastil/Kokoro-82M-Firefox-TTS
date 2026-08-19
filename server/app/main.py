import asyncio
import io
import time
from contextlib import asynccontextmanager

import soundfile as sf
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from .config import load_config
from .tts import MODEL_ID, SAMPLE_RATE, ModelState, load_model, synthesize, unload_model

config, config_path, is_new = load_config()
state = ModelState()

# Guards load_model()/unload_model() against running concurrently -- e.g.
# a request reloading an idled model while the watcher below decides,
# from a stale read of state.status, that it's time to unload it.
reload_lock = asyncio.Lock()


async def ensure_model_ready():
    """If the model was unloaded due to inactivity, reload it in place.
    Called from /health and /synthesize so the reload happens
    transparently -- the caller just sees a slower response, the same
    way it already tolerates the initial cold-start "loading" status."""
    if state.status != "idle":
        return
    async with reload_lock:
        if state.status == "idle":  # re-check: another request may have already reloaded it
            print("[server] model was unloaded (idle) -- reloading for this request...")
            state.status = "loading"
            await asyncio.to_thread(load_model, state)


async def idle_unload_watcher():
    while True:
        await asyncio.sleep(30)
        if config.idle_unload_minutes <= 0:
            continue  # auto-unload disabled
        if state.status != "ready":
            continue
        idle_for = time.monotonic() - state.last_used
        if idle_for < config.idle_unload_minutes * 60:
            continue
        async with reload_lock:
            if state.status == "ready" and time.monotonic() - state.last_used >= config.idle_unload_minutes * 60:
                await asyncio.to_thread(unload_model, state)


@asynccontextmanager
async def lifespan(app: FastAPI):
    print(f"[server] config: {config_path}")
    if is_new:
        print("[server] generated a new auth token.")
    print(f"[server] auth token: {config.token}")
    print("[server] paste this into the extension's Settings > Companion server.")
    if config.idle_unload_minutes > 0:
        print(f"[server] idle-unload: model unloads after {config.idle_unload_minutes} min of inactivity.")
    # Runs in a worker thread so /health can respond ("loading") while
    # the (possibly slow, first-run-downloads-weights) model load is
    # still in progress, instead of blocking startup entirely.
    asyncio.create_task(asyncio.to_thread(load_model, state))
    asyncio.create_task(idle_unload_watcher())
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
    # If idle-unloaded, reload right here so a health check immediately
    # before a read (which is exactly when/how the extension calls this)
    # doesn't report "idle" and get treated as not-ready for no reason.
    await ensure_model_ready()
    return {
        "status": state.status,
        "device": "cpu",
        "modelId": MODEL_ID,
        "error": state.error,
    }


@app.post("/synthesize")
async def synthesize_endpoint(body: SynthesizeRequest, _: None = Depends(require_auth)):
    await ensure_model_ready()
    if state.status != "ready":
        raise HTTPException(status_code=503, detail=f"Model not ready ({state.status})")
    state.last_used = time.monotonic()

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
