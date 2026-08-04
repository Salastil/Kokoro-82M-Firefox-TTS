// Loads (or creates, on first run) the server config file. Kept
// outside the repo entirely (under XDG_CONFIG_HOME) so the generated
// auth token can never accidentally end up committed to git.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const CONFIG_DIR = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
  "kokoro-reader-server"
);
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

const DEFAULTS = {
  host: "127.0.0.1",
  port: 8787,
  dtype: "q8", // q4 | q8 | fp32 -- see README for the tradeoffs
};

export function loadConfig() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  let config;
  let isNew = false;
  if (fs.existsSync(CONFIG_PATH)) {
    config = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
  } else {
    isNew = true;
    config = { ...DEFAULTS, token: crypto.randomBytes(32).toString("hex") };
  }

  if (!config.token) {
    isNew = true;
    config.token = crypto.randomBytes(32).toString("hex");
  }

  if (isNew) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  }

  // Env overrides are mainly for the systemd unit / quick local testing
  // without hand-editing the config file.
  if (process.env.KOKORO_PORT) config.port = Number(process.env.KOKORO_PORT);
  if (process.env.KOKORO_HOST) config.host = process.env.KOKORO_HOST;
  if (process.env.KOKORO_DTYPE) config.dtype = process.env.KOKORO_DTYPE;

  return { config, configPath: CONFIG_PATH, isNew };
}
