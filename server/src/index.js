import { loadConfig } from "./config.js";
import { createApp } from "./app.js";

const { config, configPath, isNew } = loadConfig();

console.log(`[server] config: ${configPath}`);
if (isNew) {
  console.log(`[server] generated a new auth token.`);
}
console.log(`[server] auth token: ${config.token}`);
console.log(`[server] paste this into the extension's Settings > Companion server.`);

const app = createApp({ config });
app.listen(config.port, config.host, () => {
  console.log(`[server] listening on http://${config.host}:${config.port}`);
});
