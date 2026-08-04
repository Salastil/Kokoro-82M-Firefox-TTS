// Bundles every extension entry point that pulls in npm packages
// (webextension-polyfill, @mozilla/readability) into single files
// under extension/. There's no runtime/WASM vendoring step anymore --
// synthesis happens on the companion server, not in the browser.
import * as esbuild from "esbuild";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

const builds = [
  {
    entryPoints: [path.join(root, "src/background/background.js")],
    outfile: path.join(root, "extension/background/background.bundle.js"),
    format: "esm",
  },
  {
    entryPoints: [path.join(root, "src/content/content.js")],
    outfile: path.join(root, "extension/content/content.bundle.js"),
    format: "iife",
  },
  {
    entryPoints: [path.join(root, "src/popup/popup.js")],
    outfile: path.join(root, "extension/popup/popup.bundle.js"),
    format: "iife",
  },
  {
    entryPoints: [path.join(root, "src/options/options.js")],
    outfile: path.join(root, "extension/options/options.bundle.js"),
    format: "iife",
  },
];

const common = {
  bundle: true,
  platform: "browser",
  target: ["firefox121", "chrome110"],
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  logLevel: "info",
};

async function main() {
  await Promise.all(builds.map((b) => rm(b.outfile, { force: true })));

  if (watch) {
    const ctxs = await Promise.all(
      builds.map((b) => esbuild.context({ ...common, ...b }))
    );
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log("Watching for changes...");
    return;
  }

  for (const b of builds) {
    await esbuild.build({ ...common, ...b });
  }
  console.log("Build complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
