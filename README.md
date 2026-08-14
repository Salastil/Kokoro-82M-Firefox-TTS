# Kokoro Reader

A cross-browser extension (Firefox + Chromium: Brave, Chrome, etc.)
that reads articles or selected text aloud using
[Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M),
synthesized by a small **companion server you run on your own machine**
-- no cloud TTS API, no text leaving your network. The server is
CPU-only (see "Why Python, and why a companion server at all?" below
for the history -- it used to also support NVIDIA/AMD GPU acceleration,
removed since it wasn't worth maintaining two hardware backends nobody
here could reliably test against).

The extension and server don't have to be on the same machine -- see
"Remote access (listening mode)" under Docker below to run the server
on one machine and use the extension from a browser on another.

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

This creates a venv, installs CPU-only `torch` and the rest of the
dependencies, and installs + starts a `systemd --user` service that
keeps the server running (and restarts it if it crashes). To also have
it start at boot without logging in first:

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
container instead (CPU only):

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

#### Remote access (listening mode)

To run the server on one machine and use the extension from a browser
on a *different* machine, publish the port on all interfaces instead
of just loopback -- everything else about the container is identical:

```bash
docker run -d --name kokoro-reader-server --restart unless-stopped \
  -p 8787:8787 \
  -v kokoro-config:/home/kokoro/.config \
  -v kokoro-hf-cache:/home/kokoro/.cache/huggingface \
  kokoro-reader-server
```

Then, in the extension's Settings on the *other* machine, set the
**Server URL** to `http://<server-machine-lan-ip>:8787` and paste the
auth token from `docker logs kokoro-reader-server`. Click **Test
connection** -- your browser will prompt for permission to reach that
host the first time (the extension only has permission for
localhost by default; this is what grants it access to a specific
remote host instead of just asking for blanket network access). This
needs Firefox 128+ (older Firefox only supports loopback servers) or
any current Chromium browser.

**This has no transport security beyond the bearer token** -- the
connection is plain HTTP, same as the loopback default. Fine on a
trusted home LAN; don't do this across an untrusted network without
putting it behind your own TLS (a reverse proxy, a VPN/Tailscale, etc.)
first. See "Security notes" below.

#### Automatic builds (Gitea Actions)

`.gitea/workflows/docker-build.yml` builds and pushes the server image
to a Gitea container registry whenever `server/` changes on `main` (or
on demand via "Run workflow"). Two things it needs that aren't in the
file itself:

1. **A runner that can actually build Docker images** -- an
   `act_runner` registered with your Gitea instance, deployed with
   Docker-in-Docker or a mounted docker socket. That's a property of
   how the runner is deployed, not something this workflow controls.
2. **`CI_TOKEN` and `DOCKER` secrets** (Settings > Actions > Secrets on
   the repo): `CI_TOKEN` is a Gitea Personal Access Token (Settings >
   Applications > Generate New Token) used for checkout; `DOCKER` is a
   Personal Access Token with `write:package` scope used to log in to
   the container registry. Gitea's automatic per-run token isn't
   reliable for container registry auth as of writing
   ([go-gitea/gitea#23642](https://github.com/go-gitea/gitea/issues/23642)),
   so `DOCKER` has to be a real PAT, not left unset.

`REGISTRY_OWNER` near the top of the workflow file is set to `salastil`
-- change it if you fork this to push to a different Gitea
username/org (it must be lowercase; container registries reject
mixed-case repository paths).

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
status. Pointing this at a server on another machine instead? See
"Remote access (listening mode)" above.

Prefer a signed build over loading unpacked? Tagged releases (see
"Automatic builds" below) are signed by CI and published on the repo's
Releases page as a downloadable `.xpi`.

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
npm run sign:ext      # self-sign for distribution (needs WEB_EXT_API_KEY/WEB_EXT_API_SECRET env vars)
```

`build.mjs` (esbuild) bundles four entry points -- `background`,
`content`, `popup`, `options` -- each pulling in `webextension-polyfill`
(for a uniform `browser.*` promise-based API on both Firefox and
Chromium) and, for the content script, `@mozilla/readability`.

#### Automatic builds (Gitea Actions)

Split into two workflows so AMO -- which refuses to re-sign a version
it's already seen -- only gets asked to sign something once you
actually want a release, not on every trivial commit:

- **`.gitea/workflows/build-extension.yml`** runs on every push to
  `main` that touches `src/`, `extension/`, or `build.mjs` (or on
  demand via "Run workflow"). It bumps the patch version (`npm run
  version:bump`, see `scripts/bump-version.mjs` --
  `extension/manifest.json` is the source of truth, mirrored into
  `package.json`/`package-lock.json`), pushes that bump straight back
  to `main`, then builds and lints. The unsigned build is published as
  the run's build artifact -- a quick "does this still build" check,
  not a distributable release.
- **`.gitea/workflows/release.yml`** runs when you push a version tag
  (`git tag v0.2.5 && git push gitea v0.2.5` -- the tag must match
  `extension/manifest.json`'s version at that commit, normally
  whatever `build-extension.yml` last bumped it to; the workflow fails
  loudly if they don't match). It builds, self-signs with AMO
  (`unlisted`/self-distribution channel), and publishes a **Gitea
  Release** for that tag with the signed `.xpi` attached as a release
  asset.

Needs these secrets (Settings > Actions > Secrets on the repo):

- **`CI_TOKEN`** -- a Gitea Personal Access Token (Settings >
  Applications > Generate New Token) with repo read/write, used for
  checkout, to push the version-bump commit back to `main`, and (in
  `release.yml`) to create the release and upload the asset via the
  Gitea API.
- **`WEB_EXT_API_KEY`** / **`WEB_EXT_API_SECRET`** -- AMO API
  credentials from
  [addons.mozilla.org/developers/addon/api/key](https://addons.mozilla.org/developers/addon/api/key/),
  used only by `release.yml`. `web-ext` reads both automatically from
  the environment, no extra config needed.

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
                                     package, CPU only
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
gets real multi-threaded CPU inference with none of the above caveats.
The tradeoff, stated plainly: this is no longer "install the extension
and go" -- it's a second thing to install and keep running.
`server/install.sh` and the systemd unit exist to make that as close
to "install once, forget about it" as possible.

The server was first built in Node.js (reusing `kokoro-js`, the same
package the in-browser version already used), then rebuilt in Python
using the official [`kokoro`](https://pypi.org/project/kokoro/) package
(PyTorch-based) so it could also accelerate AMD GPUs via ROCm, which
`onnxruntime-node` (Node's ONNX Runtime binding) had no build for.
That GPU support -- both NVIDIA/CUDA and AMD/ROCm -- was later removed:
two hardware backends nobody maintaining this could reliably test
against wasn't worth carrying, and CPU inference is fast enough in
practice for real-time-ish article playback. The server stayed Python
even after dropping GPU support since the `kokoro` package itself is
Python-only.

## Security notes

- The companion server binds to loopback by default
  (`127.0.0.1`/`localhost`) and requires a random bearer token
  generated on first run for every request, including `/health`.
  Without the token, an unauthenticated local server would be
  reachable by *any* page you visit, not just this extension (a classic
  localhost-CSRF risk) -- the token is the actual access control here,
  not network exposure.
- Don't put the server on a network-reachable host without adding your
  own transport security. Loopback is the default; "listening mode"
  (see Docker above) exposes it to your LAN deliberately, and the
  extension only gets access to a non-localhost host after you
  explicitly grant it permission (a browser-native prompt) via
  Settings > Test connection -- it never has blanket network access.
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
- CPU only -- GPU acceleration (NVIDIA/CUDA, AMD/ROCm) was supported at
  one point and has since been removed; see "Why Python" above.
- Not listed on AMO or a Chrome/Brave store, so there's no auto-update
  channel -- CI produces a signed, self-distributed (`unlisted`) `.xpi`
  per tagged release (see "Automatic builds" above), but you
  install/update it manually. `web-ext lint` reports 0 errors, 5 expected warnings:
  `MANIFEST_FIELD_UNSUPPORTED` for `background.service_worker` (Firefox
  doesn't support this key, but tolerates its presence alongside
  `background.scripts`, which it does read -- this dual declaration is
  the documented cross-browser compatibility pattern, not a bug); two
  `KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION` warnings because
  `optional_host_permissions` (used for the listening-mode permission
  prompt) needs Firefox 128+ while `strict_min_version` is 121 --
  expected, see "Remote access (listening mode)" and "Limitations"
  above; and two `UNSAFE_VAR_ASSIGNMENT` warnings for `innerHTML` from
  the vendored Readability library operating on a cloned/same-origin
  DOM (the same pattern Firefox's own Reader View relies on).
- The server has no HTTPS/TLS -- fine for loopback or trusted-LAN use,
  not for exposing it beyond that without your own transport security.
- Remote/listening-mode host permission requests (`optional_host_permissions`)
  need Firefox 128+; older Firefox is limited to loopback servers.

## Credits

- [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) and the
  [`kokoro`](https://pypi.org/project/kokoro/) Python package by hexgrad (Apache-2.0)
- [Mozilla Readability](https://github.com/mozilla/readability) (Apache-2.0)
- [webextension-polyfill](https://github.com/mozilla/webextension-polyfill) (MPL-2.0)

This project's own code is MIT licensed (see `LICENSE`).
