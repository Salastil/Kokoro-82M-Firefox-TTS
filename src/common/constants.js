// Shared constants used across background/popup/options/content. A
// plain ESM module now that everything is bundled with esbuild (no
// more "some files are plain scripts, some are bundled" split).

export const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

// English voices shipped with Kokoro-82M v1.0. (Other languages exist
// upstream but need a matching phonemizer language pack; out of scope
// for now.)
export const KOKORO_VOICES = [
  { id: "af_heart", label: "Heart (US, female)" },
  { id: "af_alloy", label: "Alloy (US, female)" },
  { id: "af_aoede", label: "Aoede (US, female)" },
  { id: "af_bella", label: "Bella (US, female)" },
  { id: "af_jessica", label: "Jessica (US, female)" },
  { id: "af_kore", label: "Kore (US, female)" },
  { id: "af_nicole", label: "Nicole (US, female)" },
  { id: "af_nova", label: "Nova (US, female)" },
  { id: "af_river", label: "River (US, female)" },
  { id: "af_sarah", label: "Sarah (US, female)" },
  { id: "af_sky", label: "Sky (US, female)" },
  { id: "am_adam", label: "Adam (US, male)" },
  { id: "am_echo", label: "Echo (US, male)" },
  { id: "am_eric", label: "Eric (US, male)" },
  { id: "am_fenrir", label: "Fenrir (US, male)" },
  { id: "am_liam", label: "Liam (US, male)" },
  { id: "am_michael", label: "Michael (US, male)" },
  { id: "am_onyx", label: "Onyx (US, male)" },
  { id: "am_puck", label: "Puck (US, male)" },
  { id: "am_santa", label: "Santa (US, male)" },
  { id: "bf_alice", label: "Alice (UK, female)" },
  { id: "bf_emma", label: "Emma (UK, female)" },
  { id: "bf_isabella", label: "Isabella (UK, female)" },
  { id: "bf_lily", label: "Lily (UK, female)" },
  { id: "bm_daniel", label: "Daniel (UK, male)" },
  { id: "bm_fable", label: "Fable (UK, male)" },
  { id: "bm_george", label: "George (UK, male)" },
  { id: "bm_lewis", label: "Lewis (UK, male)" },
];

export const DEFAULT_SETTINGS = {
  voice: "af_heart",
  speed: 1.0,
  chunkChars: 400, // max characters sent to the server per synthesis request
  serverUrl: "http://127.0.0.1:8787",
  serverToken: "",
};

export const STORAGE_KEY = "kokoroReaderSettings";
