// Bumps the patch version in extension/manifest.json (the canonical
// source of truth -- it's what AMO actually signs) and mirrors it into
// package.json/package-lock.json via `npm version` so all three stay
// in sync. Run by CI on every push to main before building; can also
// be run manually (`npm run version:bump`) before a release.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifestPath = path.join(root, "extension/manifest.json");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(manifest.version);
if (!match) {
  throw new Error(`extension/manifest.json version "${manifest.version}" isn't major.minor.patch`);
}
const [, major, minor, patch] = match;
const nextVersion = `${major}.${minor}.${Number(patch) + 1}`;

manifest.version = nextVersion;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

execFileSync("npm", ["version", nextVersion, "--no-git-tag-version", "--allow-same-version"], {
  cwd: root,
  stdio: "ignore",
});

// Only the new version on stdout -- callers (CI) capture this directly.
console.log(nextVersion);
