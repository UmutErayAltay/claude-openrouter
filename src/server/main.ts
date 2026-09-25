import { appendFileSync, mkdirSync } from "node:fs";
import { configDir, loadConfig, logPath, migrateLegacyKey } from "../config.js";
import { createProxyServer } from "./index.js";

/** Entry point for the detached proxy process started by `cor start`. */
migrateLegacyKey();
const port = Number(process.env.CLAUDE_OPENROUTER_PORT ?? loadConfig().port);

mkdirSync(configDir(), { recursive: true, mode: 0o700 });

function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    appendFileSync(logPath(), line);
  } catch {
    process.stderr.write(line);
  }
}

const server = createProxyServer({ log });

// A dashboard-triggered restart spawns the replacement before the current
// process has released the port, so the new one has to wait its turn rather
// than fail outright.
const MAX_LISTEN_RETRIES = 20;
const RETRY_DELAY_MS = 250;
let listenAttempts = 0;

function tryListen(): void {
  server.listen(port, "127.0.0.1");
}

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE" && listenAttempts < MAX_LISTEN_RETRIES) {
    listenAttempts += 1;
    setTimeout(tryListen, RETRY_DELAY_MS);
    return;
  }
  log(`dinleme hatasi: ${err.message}`);
  process.exit(1);
});

server.on("listening", () => {
  log(`proxy dinliyor: http://127.0.0.1:${port}`);
});

tryListen();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log(`${signal} alindi, kapaniyor`);
    server.close(() => process.exit(0));
  });
}
