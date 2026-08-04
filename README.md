# Kokoro Reader

A cross-browser extension (Firefox + Chromium: Brave, Chrome, etc.)
that reads articles or selected text aloud using
[Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX),
synthesized by a small **companion server you run on your own machine**
-- no cloud TTS API, no text leaving your network. The server prefers
GPU acceleration (CUDA) when available and transparently falls back to
CPU otherwise.

This used to run entirely in-browser via WASM. It doesn't anymore --
see "Why a companion server?" below for why that was abandoned.

## Components

```
extension/     the browser extension (Manifest V3, Firefox + Chromium)
server/        the companion TTS server (Node.js + kokoro-js)
```

They're independent: the server has no browser dependency and can run
on a headless machine; the extension just needs a server it can reach
to work.

## 1. Set up the companion server

Requires Node.js 20+.

```bash
cd server
./install.sh
```

This installs dependencies, and installs + starts a `systemd --user`
service that keeps the server running (and restarts it if it crashes).
To also have it start at boot without logging in first:

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
Hugging Face (~85MB by default); after that they're cached under the
server's own cache directory and it starts instantly.

Useful commands:

```bash
systemctl --user status kokoro-reader-server
journalctl --user -u kokoro-reader-server -f
systemctl --user restart kokoro-reader-server   # after editing config.json
```

Config lives at `~/.config/kokoro-reader-server/config.json`
(`$XDG_CONFIG_HOME` if set) -- port, model precision (`dtype`), and the
auth token. Restart the service after editing it.

To run it without systemd (e.g. to test, or on non-Linux):

```bash
cd server
npm install
npm start
```

### GPU acceleration

The server tries CUDA first, then falls back to CPU automatically --
no configuration needed either way, and `/health` reports which one is
actually in use. This only helps **NVIDIA** GPUs: the prebuilt
`onnxruntime-node` binary ships CPU + CUDA/TensorRT execution
providers on Linux x64, with no ROCm/MIGraphX build for AMD GPUs. On
AMD (or any non-CUDA) hardware it'll cleanly fall back to CPU -- which
is still native multi-threaded inference, not the single-threaded WASM
the in-browser version was stuck with (see below).

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
  src/tts.js                        model loading, cuda -> cpu fallback
  src/app.js                        Express app: /health, /synthesize
  src/config.js                     config file (port, dtype, token)
  systemd/                          user service unit template
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

## Why a companion server?

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
- GPU acceleration is CUDA-only (NVIDIA). AMD/Intel GPUs fall back to
  CPU -- there's no readily available ROCm/MIGraphX build for
  `onnxruntime-node`; building one yourself is possible but out of
  scope here.
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

- [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) by hexgrad (Apache-2.0)
- [kokoro-js](https://github.com/hexgrad/kokoro/tree/main/kokoro.js) /
  [@huggingface/transformers](https://github.com/huggingface/transformers.js) (Apache-2.0/MIT)
- [Mozilla Readability](https://github.com/mozilla/readability) (Apache-2.0)
- [webextension-polyfill](https://github.com/mozilla/webextension-polyfill) (MPL-2.0)

This project's own code is MIT licensed (see `LICENSE`).
