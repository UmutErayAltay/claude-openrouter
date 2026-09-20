import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configDir, loadConfig, logPath, pidPath } from "./config.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Built layout is dist/cli/index.js next to dist/server/main.js. */
function serverEntry(): string {
  const candidates = [
    join(here, "..", "server", "main.js"),
    join(here, "server", "main.js"),
    join(here, "..", "src", "server", "main.ts"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("Proxy giris dosyasi bulunamadi. `npm run build` calistirdin mi?");
  return found;
}

export function readPid(): number | undefined {
  const path = pidPath();
  if (!existsSync(path)) return undefined;
  const pid = Number(readFileSync(path, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

export function isRunning(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    // Signal 0 tests for the process without touching it.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function isPortAnswering(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function startProxy(): Promise<{ port: number; alreadyRunning: boolean }> {
  const port = loadConfig().port;

  if (await isPortAnswering(port)) return { port, alreadyRunning: true };

  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const out = openSync(logPath(), "a");

  const child = spawn(process.execPath, [serverEntry()], {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, CLAUDE_OPENROUTER_PORT: String(port) },
  });
  child.unref();

  if (child.pid) writeFileSync(pidPath(), `${child.pid}\n`);

  // Wait for the listener rather than assuming it came up.
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await isPortAnswering(port)) return { port, alreadyRunning: false };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Proxy baslatilamadi. Log: ${logPath()}`);
}

export function stopProxy(): boolean {
  const pid = readPid();
  if (!isRunning(pid)) {
    rmSync(pidPath(), { force: true });
    return false;
  }
  process.kill(pid as number, "SIGTERM");
  rmSync(pidPath(), { force: true });
  return true;
}
