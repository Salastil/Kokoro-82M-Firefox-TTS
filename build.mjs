// Bundles the pieces of the extension that pull in npm packages
// (the TTS worker -> kokoro-js/@huggingface/transformers, and the
// content script -> @mozilla/readability). Everything else in
// extension/ is plain browser JS and is used as-is, unbundled.
import * as esbuild from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

const builds = [
  {
    entryPoints: [path.join(root, "src/worker/tts-worker.js")],
    outfile: path.join(root, "extension/worker/tts-worker.bundle.js"),
    format: "esm",
  },
  {
    entryPoints: [path.join(root, "src/content/content.js")],
    outfile: path.join(root, "extension/content/content.bundle.js"),
    format: "iife",
  },
];

const common = {
  bundle: true,
  platform: "browser",
  target: ["firefox115"],
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  logLevel: "info",
};

async function copyRuntimeAssets() {
  // The ONNX Runtime Web WASM binary + loader that ships inside
  // @huggingface/transformers' own dist/ (matched to the exact ORT
  // version it expects). Vendored locally so the extension never
  // fetches executable code from a remote host at runtime -- only
  // model *weights* (data) are fetched, from Hugging Face, which is
  // declared explicitly in the manifest's connect-src / permissions.
  const src = path.join(
    root,
    "node_modules/@huggingface/transformers/dist"
  );
  const dest = path.join(root, "extension/runtime");
  await mkdir(dest, { recursive: true });
  for (const file of [
    "ort-wasm-simd-threaded.jsep.mjs",
    "ort-wasm-simd-threaded.jsep.wasm",
  ]) {
    await cp(path.join(src, file), path.join(dest, file));
  }
}

async function main() {
  await rm(path.join(root, "extension/worker/tts-worker.bundle.js"), {
    force: true,
  });
  await rm(path.join(root, "extension/content/content.bundle.js"), {
    force: true,
  });

  if (watch) {
    const ctxs = await Promise.all(
      builds.map((b) => esbuild.context({ ...common, ...b }))
    );
    await Promise.all(ctxs.map((c) => c.watch()));
    await copyRuntimeAssets();
    console.log("Watching for changes...");
    return;
  }

  for (const b of builds) {
    await esbuild.build({ ...common, ...b });
  }
  await copyRuntimeAssets();
  console.log("Build complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
