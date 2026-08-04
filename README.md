# Kokoro Reader — Local TTS for Firefox

A Firefox extension that reads articles or selected text aloud using
[Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX),
running **entirely in your browser, on CPU** — no server, no cloud API,
nothing sent anywhere except a one-time download of the model weights
from Hugging Face (which the browser then caches locally).

## Features

- **Read selected text** — right-click a selection → "Read selection aloud
  (Kokoro)", or use the toolbar popup.
- **Read a whole article** — right-click a page → "Read article aloud
  (Kokoro)". The page is parsed with Mozilla's [Readability](https://github.com/mozilla/readability)
  (the same engine behind Firefox's Reader View), shown in a clean
  reading overlay, and read paragraph by paragraph with the current
  paragraph highlighted (click any paragraph to jump playback there).
  Click **minimize (—)** to collapse the overlay into the same small
  floating mini-player used for selection reads — playback keeps going,
  and **⤢** brings the full overlay back.
- **Play / pause / stop** from the popup, the overlay, or the floating
  mini-player.
- 28 English voices (US + UK), adjustable speed, and a choice of model
  precision (quality vs. speed/size) in Settings.
- **Runs on CPU by default**, via ONNX Runtime Web's WASM backend — no
  GPU or native dependencies required. GPU acceleration (WebGPU) is
  available as an opt-in checkbox in Settings → Performance, for
  systems where it's supported; if it's not, playback automatically
  falls back to CPU and the status bar says so.

## Install (unpacked, for now)

This isn't on addons.mozilla.org (yet), so load it as a temporary
add-on:

1. Clone this repo (the `extension/` folder is fully self-contained —
   built bundles and the ONNX Runtime WASM binary are already checked in,
   so no build step is required to try it).
2. In Firefox, go to `about:debugging#/runtime/this-firefox`.
3. Click **"Load Temporary Add-on…"** and select `extension/manifest.json`.
4. Select some text on any page, right-click, choose **"Read selection
   aloud (Kokoro)"**. The first read downloads the model (~85MB by
   default); after that it's cached and starts instantly.

("Temporary" add-ons are removed when Firefox restarts — for
persistent use you'd package and sign it, see [Firefox extension
docs](https://extensionworkshop.com/documentation/publish/).)

## Building from source

Only needed if you change code under `src/`:

```bash
npm install
npm run build      # bundles src/worker + src/content into extension/
npm run lint:ext    # web-ext lint against extension/
npm run run:ext      # launches a temporary Firefox profile with it loaded
```

`build.mjs` (esbuild) does two things:
- Bundles `src/worker/tts-worker.js` (kokoro-js + `@huggingface/transformers`)
  into `extension/worker/tts-worker.bundle.js`, loaded as a module Worker.
- Bundles `src/content/content.js` (`@mozilla/readability`) into
  `extension/content/content.bundle.js`, the content script.
- Copies the ONNX Runtime Web WASM runtime (`ort-wasm-simd-threaded.jsep.{mjs,wasm}`,
  vendored from `@huggingface/transformers`'s own `dist/`) into
  `extension/runtime/`.

Everything else in `extension/` (background script, popup, options,
manifest) is plain browser JS/HTML/CSS with no build step.

## Architecture

```
extension/
  background/background.js   persistent MV2 background page:
                              owns the Worker, an <audio> element for
                              playback, context menus, and message
                              routing between popup/content scripts
  worker/tts-worker.bundle.js  dedicated module Worker: owns the
                              Kokoro-82M model + ONNX Runtime session,
                              does all synthesis (never blocks the UI)
  content/content.bundle.js  per-tab: Readability extraction, text
                              selection, the reading overlay / mini-player
  popup/                     toolbar popup: quick controls + voice/speed
  options/                   voice/speed defaults, model quality, cache
  runtime/                   vendored ONNX Runtime Web WASM binary
```

Text flows as: content script extracts paragraph-level segments (or a
selection) → background sends them to the worker → worker chunks each
segment into sentence-sized pieces, synthesizes each with Kokoro-82M
(WASM, CPU) and posts back WAV audio → background plays chunks back
sequentially through an `<audio>` element and tells the content script
which paragraph is currently playing, for highlighting.

## Privacy / what leaves your machine

- **Text and audio never leave your computer.** All synthesis runs
  in a Web Worker using ONNX Runtime Web's WASM (CPU) backend.
- The **only** network requests are to `huggingface.co` (and its CDN
  subdomains) to download the Kokoro-82M model weights and voice
  embeddings the first time you use them. These are cached by the
  browser (Cache API) and not re-fetched afterward — see Settings →
  Storage to check/clear the cache.
- The WASM runtime itself (ONNX Runtime Web) is vendored inside the
  extension (`extension/runtime/`), not fetched from a CDN at
  runtime — the only thing fetched remotely is model *data*, never
  executable code.

## Settings

- **Voice / speed** — also available directly in the popup.
- **Model quality** — `q4` (~40MB, fastest), `q8` (~85MB, default,
  recommended balance), `fp32` (~326MB, best quality, slowest on
  CPU). Changing this re-downloads weights on next use.
- **GPU acceleration (WebGPU)** — off by default (CPU/WASM). Turning
  it on asks ONNX Runtime Web to use WebGPU instead; if the browser
  doesn't report WebGPU support at read-time, it transparently uses
  CPU for that session instead of failing.
- **Max characters per synthesis chunk** — how much text is sent to
  the model per call; smaller is choppier but starts playing sooner,
  larger sounds more natural but has more latency per chunk.
- **Clear cached model data** — frees the Cache Storage entries for
  the model/tokenizer/voices.

## Limitations / known issues (v0.1)

- English only (US/UK voices). Kokoro-82M supports other languages
  upstream, but they need a different phonemizer language pack this
  extension doesn't wire up yet.
- The reading overlay renders Readability's extracted text only
  (no inline formatting/links/images) — this is deliberate: it's built
  from plain text nodes, not injected HTML, so an untrusted page's
  markup can't run script or styling inside the overlay.
- No cross-page style isolation (no Shadow DOM) for the overlay/mini-player;
  class names are namespaced and fairly high-specificity, but a
  sufficiently hostile page stylesheet could still interfere visually.
- Threaded WASM (faster, uses multiple CPU cores) needs
  `SharedArrayBuffer`; Firefox extension pages typically have this
  available without extra configuration, but if your build/profile
  doesn't, it falls back to a single thread automatically (slower,
  still correct).
- Not signed/listed on AMO. `web-ext lint` reports 0 errors, but 5
  expected warnings (`UNSAFE_VAR_ASSIGNMENT` for `innerHTML`/dynamic
  `import()`, `DANGEROUS_EVAL` for the `Function` constructor) that
  come from the vendored Readability and ONNX Runtime Web libraries
  operating on a cloned/same-origin DOM and instantiating WebAssembly,
  respectively — both standard, expected patterns for these libraries
  (the same ones Firefox's own Reader View and Mozilla's
  Translations feature rely on), not bugs in this extension's code.
- Built/vendored binaries (`extension/worker/tts-worker.bundle.js`,
  `extension/runtime/*.wasm`) are checked into the repo for
  load-unpacked convenience, which makes this repo larger than a
  typical source-only project (~20MB, dominated by the ONNX Runtime
  WASM binary).

## Credits

- [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) by hexgrad (Apache-2.0)
- [kokoro-js](https://github.com/hexgrad/kokoro/tree/main/kokoro.js) /
  [@huggingface/transformers](https://github.com/huggingface/transformers.js) (Apache-2.0/MIT)
- [Mozilla Readability](https://github.com/mozilla/readability) (Apache-2.0)

This project's own code is MIT licensed (see `LICENSE`).
