import express from "express";
import { loadModel, MODEL_ID } from "./tts.js";

export function createApp({ config }) {
  const app = express();
  app.use(express.json({ limit: "256kb" }));

  // Extension-privileged fetches are typically exempt from CORS
  // enforcement, but headers are set anyway so this doesn't depend on
  // that being true in every engine/context. Real access control is
  // the bearer token below, not this.
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  let modelState = { status: "loading", device: null, error: null, tts: null };

  loadModel(config.dtype)
    .then(({ tts, device }) => {
      modelState = { status: "ready", device, error: null, tts };
      console.log(`[server] ready (device=${device}, dtype=${config.dtype})`);
    })
    .catch((err) => {
      modelState = { status: "error", device: null, error: err.message, tts: null };
      console.error("[server] failed to load model:", err);
    });

  function requireAuth(req, res, next) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token || token !== config.token) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  }

  app.get("/health", requireAuth, (req, res) => {
    res.json({
      status: modelState.status, // "loading" | "ready" | "error"
      device: modelState.device, // "cuda" | "cpu" | null
      dtype: config.dtype,
      modelId: MODEL_ID,
      error: modelState.error,
    });
  });

  app.post("/synthesize", requireAuth, async (req, res) => {
    if (modelState.status !== "ready") {
      return res.status(503).json({ error: `Model not ready (${modelState.status})` });
    }

    const { text, voice, speed } = req.body || {};
    if (typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "text is required" });
    }
    if (text.length > 2000) {
      return res.status(400).json({ error: "text too long (max 2000 chars per request)" });
    }
    const safeSpeed = Math.min(2, Math.max(0.5, Number(speed) || 1));

    try {
      const audio = await modelState.tts.generate(text, {
        voice: voice || "af_heart",
        speed: safeSpeed,
      });
      const wav = Buffer.from(audio.toWav());
      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("X-Sample-Rate", String(audio.sampling_rate));
      res.send(wav);
    } catch (err) {
      console.error("[server] synthesis error:", err);
      res.status(500).json({ error: err.message || "Synthesis failed" });
    }
  });

  return app;
}
