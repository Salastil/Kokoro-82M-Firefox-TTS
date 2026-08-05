# Kokoro Reader

A cross-browser extension (Firefox + Chromium: Brave, Chrome, etc.)
that reads articles or selected text aloud using
[Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M),
synthesized by a small **companion server you run on your own machine**
-- no cloud TTS API, no text leaving your network. The server prefers
GPU acceleration when available (**NVIDIA via CUDA, AMD via ROCm**) and
transparently falls back to CPU otherwise.

This used to run entirely in-browser via WASM, then moved to a Node.js
companion server that could only accelerate NVIDIA GPUs. Now it's a
Python server instead, specifically so AMD GPUs (ROCm) work too -- see
"Why Python, and why a companion server at all?" below.

## Components

```
extension/     the browser extension (Manifest V3, Firefox + Chromium)
server/        the companion TTS server (Python + the `kokoro` package)
```

They're independent: the server has no browser dependency and can run
on a headless machine; the extension just needs a server it can reach
to work.

## 1. Set up the companion server

Requires **Python 3.10, 3.11, or 3.12 specifically** (the `kokoro`
package doesn't support 3.13+ yet), and `espeak-ng` installed
system-wide (used by the phonemizer for out-of-dictionary words):

```bash
sudo apt install espeak-ng      # or: pacman -S espeak-ng / dnf install espeak-ng
```

On a rolling-release distro (Arch, etc.) the official repos often only
ship the latest Python, with no easy package for an older minor
version. `install.sh` looks for `python3.12`/`3.11`/`3.10` on `PATH`
first; if none are found but [`uv`](https://docs.astral.sh/uv/) is
installed, it uses that to fetch an isolated Python 3.12 without
touching your system Python at all. Easiest fix if you hit this:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

```bash
cd server
./install.sh
```

This creates a venv, detects your GPU and installs a matching `torch`
build (ROCm for AMD, CUDA for NVIDIA, plain CPU otherwise -- see
"GPU acceleration" below), installs the rest of the dependencies, and
installs + starts a `systemd --user` service that keeps the server
running (and restarts it if it crashes). To also have it start at boot
without logging in first:

```bash
loginctl enable-linger $USER
```

On first start, the server generates a random auth token and prints
it (also in `journalctl --user -u kokoro-reader-server`, and in its
config file, see below) -- you'll paste this into the extension's
settings in the next step:

```
[server] auth token: 7c1e...redacted...
[server] paste this into the extension's Settings > Companion server.
```

The first request to the server downloads Kokoro-82M's weights from
Hugging Face (~330MB, the original PyTorch checkpoint); after that
they're cached under Hugging Face's usual local cache
(`~/.cache/huggingface`) and it starts instantly.

Useful commands:

```bash
systemctl --user status kokoro-reader-server
journalctl --user -u kokoro-reader-server -f
systemctl --user restart kokoro-reader-server   # after editing config.json
```

Config lives at `~/.config/kokoro-reader-server/config.json`
(`$XDG_CONFIG_HOME` if set) -- port and the auth token. Restart the
service after editing it.

To run it without systemd (e.g. to test, or on non-Linux):

```bash
cd server
source .venv/bin/activate
python -m app.main
```

### Docker

An alternative to `install.sh`/systemd: build and run the server as a
container instead. CPU by default (works anywhere, no GPU vendor
detection needed since the build target is explicit):

```bash
cd server
docker build -t kokoro-reader-server .
docker run -d --name kokoro-reader-server --restart unless-stopped \
  -p 127.0.0.1:8787:8787 \
  -v kokoro-config:/home/kokoro/.config \
  -v kokoro-hf-cache:/home/kokoro/.cache/huggingface \
  kokoro-reader-server
docker logs -f kokoro-reader-server   # find the auth token here on first run
```

Or with `docker-compose.yml` (`docker compose up -d --build`), which
has the same volumes/port-mapping built in and also tags the build as
`git.salastil.com/salastil/kokoro-reader-server:cpu` (edit that to your
own registry path) so `docker compose push` (after `docker login
git.salastil.com`) has somewhere real to push to -- run it once on a
build machine, then `docker compose pull && docker compose up -d`
anywhere else (e.g. a NAS) to just run the prebuilt image without
needing to build there at all.

The two volumes matter: without them, both the auth token and the
downloaded model weights (~330MB) would be lost every time the
container is recreated. `-p 127.0.0.1:8787:8787` keeps it reachable
only from this machine, matching the non-Docker default -- the
container itself binds `0.0.0.0` internally (required for Docker's
port mapping to work at all), so the *host*-side loopback binding is
what actually keeps this off your LAN.

For GPU, pass a different `TORCH_INDEX_URL` build arg and the matching
device flags:

```bash
# AMD (ROCm) -- also needs rocm-hip-sdk installed on the host, see
# the ROCm setup notes above; the container just needs device access.
docker build --build-arg TORCH_INDEX_URL=https://download.pytorch.org/whl/rocm6.2 \
  -t kokoro-reader-server .
docker run -d --name kokoro-reader-server --restart unless-stopped \
  -p 127.0.0.1:8787:8787 \
  --device=/dev/kfd --device=/dev/dri \
  --group-add video --group-add render \
  -v kokoro-config:/home/kokoro/.config \
  -v kokoro-hf-cache:/home/kokoro/.cache/huggingface \
  kokoro-reader-server

# NVIDIA (CUDA) -- requires the NVIDIA Container Toolkit on the host.
docker build --build-arg TORCH_INDEX_URL=https://download.pytorch.org/whl/cu121 \
  -t kokoro-reader-server .
docker run -d --name kokoro-reader-server --restart unless-stopped \
  -p 127.0.0.1:8787:8787 --gpus all \
  -v kokoro-config:/home/kokoro/.config \
  -v kokoro-hf-cache:/home/kokoro/.cache/huggingface \
  kokoro-reader-server
```

**I haven't been able to test the GPU-in-Docker paths myself** (no GPU
and no Docker daemon available in the sandbox this was built in --
only the CPU path's Dockerfile logic has been carefully hand-checked,
not built). PyTorch's ROCm/CUDA wheels are meant to bundle their own
runtime libraries so a plain `python:3.12-slim` base should work, but
if the container starts and `/health` never leaves `"loading"` (or
errors about missing shared libraries), that's the first thing to
suspect -- report back and I'll adjust the base image.

#### Automatic builds (Gitea Actions)

`.gitea/workflows/docker-build.yml` builds and pushes `cpu`, `rocm`,
and `cuda` tagged images to a Gitea container registry whenever
`server/` changes on `main` (or on demand via "Run workflow"). Two
things it needs that aren't in the file itself:

1. **A runner that can actually build Docker images** -- an
   `act_runner` registered with your Gitea instance, deployed with
   Docker-in-Docker or a mounted docker socket. That's a property of
   how the runner is deployed, not something this workflow controls.
2. **A `REGISTRY_TOKEN` secret** (Settings > Actions > Secrets on the
   repo) -- a Personal Access Token with `write:package` scope
   (Settings > Applications > Generate New Token). Gitea's automatic
   per-run token isn't reliable for container registry auth as of
   writing ([go-gitea/gitea#23642](https://github.com/go-gitea/gitea/issues/23642)),
   so this has to be a real PAT, not left unset.

Also edit `REGISTRY_OWNER: CHANGEME` near the top of the workflow file
to your actual Gitea username/org before it'll push anywhere useful.

### GPU acceleration

Device selection is handled entirely by PyTorch: the server asks for
the `cuda` device, and PyTorch auto-detects whether that's actually
usable, falling back to CPU if not. This isn't NVIDIA-specific despite
the name -- **ROCm's whole design is that a ROCm-flavored PyTorch
build makes AMD GPUs answer to the same `torch.cuda` APIs** as NVIDIA
ones, so the exact same code path accelerates both vendors with zero
AMD-specific logic needed here. `install.sh` detects your GPU
(`rocminfo`/`/opt/rocm` for AMD, `nvidia-smi` for NVIDIA) and installs
the matching `torch` build automatically; `/health` reports which one
ended up active (`device: "cuda"|"cpu"`, `gpuBackend: "rocm"|"cuda"|null`).

## 2. Install the extension

Not on a store (yet), so load it unpacked. `extension/` is
self-contained -- bundles are checked in, no build step required to
try it.

**Firefox:** `about:debugging#/runtime/this-firefox` → "Load Temporary
Add-on…" → select `extension/manifest.json`. (Temporary add-ons are
removed on restart; for persistent use you'd sign it, see
[Firefox extension docs](https://extensionworkshop.com/documentation/publish/).)

**Brave / Chrome:** `brave://extensions` or `chrome://extensions` →
enable Developer mode → "Load unpacked" → select the `extension/`
folder. Unlike Firefox, this persists across restarts without signing.

Then open the extension's options page and fill in the server URL
(`http://127.0.0.1:8787` by default) and the auth token the server
printed on first start. "Test connection" should report the model
status and which device (`cuda`/`cpu`) it's running on.

## Use

- Select text → right-click → **"Read selection aloud (Kokoro)"**, or
  use the toolbar popup.
- Right-click a page → **"Read article aloud (Kokoro)"**. The page is
  parsed with Mozilla's [Readability](https://github.com/mozilla/readability)
  (the same engine behind Firefox's Reader View) into a clean reading
  overlay, read paragraph by paragraph with the current paragraph
  highlighted (click any paragraph to jump playback there). Click
  **minimize (—)** to collapse it into the same small floating
  mini-player selection reads use -- playback keeps going, **⤢**
  brings the full overlay back.
- Play / pause / stop from the popup, the overlay, or the mini-player.
- 28 English voices (US + UK) and adjustable speed, in the popup or
  options page.

## Building from source

Only needed if you change code under `src/`:

```bash
npm install
npm run build       # bundles src/{background,content,popup,options} into extension/
npm run lint:ext     # web-ext lint against extension/ (Firefox-side validation)
npm run run:ext       # launches a temporary Firefox profile with it loaded
```

`build.mjs` (esbuild) bundles four entry points -- `background`,
`content`, `popup`, `options` -- each pulling in `webextension-polyfill`
(for a uniform `browser.*` promise-based API on both Firefox and
Chromium) and, for the content script, `@mozilla/readability`.

## Architecture

```
extension/
  background/background.bundle.js   MV3 service worker (Chromium) /
                                     event page (Firefox). No DOM
                                     dependency at all: context menus,
                                     settings, talks to the companion
                                     server, routes messages. Never
                                     plays audio itself.
  content/content.bundle.js         per-tab: Readability extraction,
                                     text selection, the reading
                                     overlay/mini-player UI, AND actual
                                     audio playback (a real page
                                     document exists here in both
                                     engines, unlike a service worker)
  popup/                            toolbar popup: quick controls +
                                     voice/speed
  options/                          companion server URL + token,
                                     voice/speed defaults, chunk size
server/
  app/tts.py                        model loading via the `kokoro`
                                     package; device selection is just
                                     "ask PyTorch for cuda", which also
                                     covers AMD/ROCm (see below)
  app/main.py                       FastAPI app: /health, /synthesize
  app/config.py                     config file (port, token)
  systemd/                          user service unit template
  Dockerfile, docker-compose.yml    containerized alternative to
                                     install.sh/systemd
```

Reading flow: content script extracts paragraph-level segments (or a
selection) → background chunks each segment into sentence-sized pieces
and calls the server's `/synthesize` **once per chunk, sequentially,
back to back** (it never waits for a chunk to finish *playing* before
requesting the next one) → each chunk's WAV audio is sent to the
content script as soon as it arrives → content script queues and plays
chunks through its own `<audio>` element, picking up the next queued
chunk the instant the current one's `ended` event fires, reporting
playback events (which paragraph is current, paused/stopped/done) back
to background so the popup stays in sync.

## Why Python, and why a companion server at all?

The original design ran Kokoro-82M entirely in-browser via ONNX
Runtime Web (WASM), no server at all. That fell apart on real hardware:
WASM only multithreads when its context is
[cross-origin isolated](https://developer.mozilla.org/en-US/docs/Web/API/crossOriginIsolated)
(`SharedArrayBuffer` usable), and Firefox restricts that to
**Mozilla-privileged extensions only** -- not something any
`about:config` flag or manifest key grants to an ordinary extension
([Bugzilla 1673477](https://bugzilla.mozilla.org/show_bug.cgi?id=1673477),
[1674383](https://bugzilla.mozilla.org/show_bug.cgi?id=1674383)). So
in-browser synthesis was permanently stuck on a single CPU core
regardless of how good the pipeline was, which on a real article-length
read falls behind real-time playback and produces audible gaps. GPU
(WebGPU) wasn't a way out either: it's exposed unevenly across
engines/platforms, and testing it against this specific model produced
distorted, garbled audio -- an upstream ONNX Runtime Web WebGPU-backend
bug in how it runs Kokoro's vocoder.

A native companion server sidesteps all of this: it's a normal OS
process, not sandboxed by browser cross-origin-isolation rules, so it
gets real multi-threaded CPU inference (or GPU, where available) with
none of the above caveats. The tradeoff, stated plainly: this is no
longer "install the extension and go" -- it's a second thing to install
and keep running. `server/install.sh` and the systemd unit exist to
make that as close to "install once, forget about it" as possible.

The server was first built in Node.js (reusing `kokoro-js`, the same
package the in-browser version already used). That worked, but only
ever accelerated **NVIDIA** GPUs: `onnxruntime-node`'s prebuilt Linux
binary ships CPU + CUDA/TensorRT execution providers only, with no
ROCm/MIGraphX build for AMD. There's also no Vulkan execution provider
in ONNX Runtime at all -- it's been requested repeatedly
([#21917](https://github.com/microsoft/onnxruntime/issues/21917),
[#7433](https://github.com/microsoft/onnxruntime/issues/7433)) but
doesn't exist; the only place Vulkan shows up is as WebGPU's backend on
Linux, and WebGPU EP is browser-only, not available in `onnxruntime-node`
in the first place (and is the same code path that produced the
garbled-audio bug above, so it wouldn't have helped even if it were).
AMD's actual supported Linux path, ROCm + MIGraphX, only ships prebuilt
wheels for **Python**, not Node -- so the server is Python now,
using the official [`kokoro`](https://pypi.org/project/kokoro/) package
(PyTorch-based) instead of `kokoro-js`. PyTorch's ROCm builds are
designed so AMD GPUs answer to the same `torch.cuda` APIs NVIDIA GPUs
do, so `device=None` (auto-detect) covers both vendors with no
AMD-specific code at all -- see "GPU acceleration" above.

## Security notes

- The companion server binds to loopback by default
  (`127.0.0.1`/`localhost`) and requires a random bearer token
  generated on first run for every request, including `/health`.
  Without the token, an unauthenticated local server would be
  reachable by *any* page you visit, not just this extension (a classic
  localhost-CSRF risk) -- the token is the actual access control here,
  not network exposure.
- Don't put the server on a network-reachable host without adding your
  own transport security; it's designed for `localhost` use.
- The reading overlay renders Readability's extracted text only (no
  inline formatting/links/images) -- deliberate: it's built from plain
  text nodes, not injected HTML, so an untrusted page's markup can't
  run script or styling inside the overlay.
- No cross-page style isolation (no Shadow DOM) for the overlay/mini-
  player; class names are namespaced and fairly high-specificity, but
  a sufficiently hostile page stylesheet could still interfere
  visually.

## Limitations / known issues

- English only (US/UK voices). Kokoro-82M supports other languages
  upstream, but they need a different phonemizer language pack this
  extension doesn't wire up yet.
- GPU acceleration covers NVIDIA (CUDA) and AMD (ROCm). Intel GPUs and
  anything else fall back to CPU -- PyTorch's mainstream GPU backends
  are CUDA and ROCm; Intel's own PyTorch extension exists but isn't
  wired up here.
- `install.sh`'s GPU detection installs a *default* ROCm/CUDA version
  tag that may not match what's actually installed on your system --
  if `/health` doesn't report the device you expected, check
  `torch.version.hip`/`torch.version.cuda` against your driver and
  reinstall the matching wheel from
  [pytorch.org/get-started/locally](https://pytorch.org/get-started/locally/).
- Not signed/listed on AMO or a Chrome/Brave store. `web-ext lint`
  reports 0 errors, 3 expected warnings: `MANIFEST_FIELD_UNSUPPORTED`
  for `background.service_worker` (Firefox doesn't support this key,
  but tolerates its presence alongside `background.scripts`, which it
  does read -- this dual declaration is the documented cross-browser
  compatibility pattern, not a bug), and two `UNSAFE_VAR_ASSIGNMENT`
  warnings for `innerHTML` from the vendored Readability library
  operating on a cloned/same-origin DOM (the same pattern Firefox's own
  Reader View relies on).
- The server has no HTTPS/TLS -- fine for loopback-only use (the
  intended setup), not for exposing it beyond your own machine.

## Credits

- [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) and the
  [`kokoro`](https://pypi.org/project/kokoro/) Python package by hexgrad (Apache-2.0)
- [Mozilla Readability](https://github.com/mozilla/readability) (Apache-2.0)
- [webextension-polyfill](https://github.com/mozilla/webextension-polyfill) (MPL-2.0)

This project's own code is MIT licensed (see `LICENSE`).
