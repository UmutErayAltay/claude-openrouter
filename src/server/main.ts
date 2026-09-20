import { appendFileSync, mkdirSync } from "node:fs";
import { configDir, loadConfig, logPath } from "../config.js";
import { createProxyServer } from "./index.js";

/** Entry point for the detached proxy process started by `cor start`. */
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

server.listen(port, "127.0.0.1", () => {
  log(`proxy dinliyor: http://127.0.0.1:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log(`${signal} alindi, kapaniyor`);
    server.close(() => process.exit(0));
  });
}
