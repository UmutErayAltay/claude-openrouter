import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  configPath,
  findModel,
  loadConfig,
  logPath,
  resolveOpenRouterKey,
  saveConfig,
  type ModelEntry,
} from "../config.js";
import {
  backupPath,
  claudeSettingsPath,
  readClaudeSettings,
  revertModelPicker,
  syncModelPicker,
} from "../claudeSettings.js";
import { fetchCatalog, searchCatalog, shortDescription } from "../openrouterCatalog.js";
import { isPortAnswering, isRunning, readPid, startProxy, stopProxy } from "../proxyProcess.js";
import { HELP } from "./help.js";

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      process.stdout.write(HELP);
      return 0;
    case "key":
      return commandKey(rest);
    case "add":
      return commandAdd(rest);
    case "remove":
      return commandRemove(rest);
    case "list":
      return commandList();
    case "search":
      return commandSearch(rest);
    case "sync":
      return commandSync(rest);
    case "start":
      return commandStart();
    case "stop":
      return commandStop();
    case "status":
      return commandStatus();
    case "doctor":
      return commandDoctor();
    case "claude":
      return commandClaude(rest);
    default:
      process.stderr.write(`Bilinmeyen komut: ${command}\n\n${HELP}`);
      return 1;
  }
}

function commandKey(args: string[]): number {
  const key = args[0];
  if (!key) {
    process.stderr.write("Kullanim: cor key <openrouter-anahtari>\n");
    return 1;
  }
  const config = loadConfig();
  config.openrouterApiKey = key;
  saveConfig(config);
  process.stdout.write(`Anahtar kaydedildi: ${configPath()} (izin 0600)\n`);
  return 0;
}

async function commandAdd(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      label: { type: "string" },
      description: { type: "string" },
      context: { type: "string" },
      "max-tokens": { type: "string" },
      "behaves-as": { type: "string" },
      "no-stream": { type: "boolean" },
      stream: { type: "boolean" },
    },
  });

  const id = positionals[0];
  if (!id) {
    process.stderr.write("Kullanim: cor add <model-id>  (ornek: cor add openai/gpt-5)\n");
    return 1;
  }

  const config = loadConfig();
  if (findModel(config, id)) {
    process.stderr.write(`${id} zaten ekli. Once 'cor remove ${id}' calistir.\n`);
    return 1;
  }

  const entry: ModelEntry = { id };
  if (values.label) entry.label = values.label;
  if (values.description) entry.description = values.description;
  if (values.context) entry.contextTokens = Number(values.context);
  if (values["max-tokens"]) entry.maxOutputTokens = Number(values["max-tokens"]);
  if (values["behaves-as"]) entry.behavesAs = values["behaves-as"];
  if (values["no-stream"]) entry.stream = false;
  if (values.stream) entry.stream = true;

  // Fill the gaps from the OpenRouter catalog so the picker row and the
  // context estimate are right without the user looking anything up.
  try {
    const catalog = await fetchCatalog(config);
    const match = catalog.find((model) => model.id === id);
    if (!match) {
      process.stderr.write(
        `Uyari: '${id}' OpenRouter katalogunda bulunamadi. 'cor search' ile dogru ID'yi arayabilirsin.\n`,
      );
    } else {
      entry.label ??= match.name ?? id;
      entry.description ??= shortDescription(match.description);
      entry.contextTokens ??= match.contextLength;
      entry.maxOutputTokens ??= match.maxCompletionTokens;
    }
  } catch (err) {
    process.stderr.write(`Uyari: katalog alinamadi (${(err as Error).message}).\n`);
  }

  config.models.push(entry);
  saveConfig(config);

  process.stdout.write(`Eklendi: ${entry.label ?? entry.id} (${entry.id})\n`);
  process.stdout.write("Simdi 'cor sync' calistirip /model menusune yansit.\n");
  return 0;
}

function commandRemove(args: string[]): number {
  const id = args[0];
  if (!id) {
    process.stderr.write("Kullanim: cor remove <model-id>\n");
    return 1;
  }
  const config = loadConfig();
  const before = config.models.length;
  config.models = config.models.filter((model) => model.id !== id);
  if (config.models.length === before) {
    process.stderr.write(`${id} listede yok.\n`);
    return 1;
  }
  saveConfig(config);
  process.stdout.write(`Cikarildi: ${id}\nSimdi 'cor sync' calistir.\n`);
  return 0;
}

function commandList(): number {
  const config = loadConfig();
  if (config.models.length === 0) {
    process.stdout.write("Hic model ekli degil. 'cor add <model-id>' ile ekle.\n");
    return 0;
  }
  for (const model of config.models) {
    const context = model.contextTokens ? `, ${model.contextTokens.toLocaleString("tr-TR")} token` : "";
    process.stdout.write(`${model.id}\n  ${model.label ?? model.id}${context}\n`);
  }
  return 0;
}

async function commandSearch(args: string[]): Promise<number> {
  const query = args.join(" ").trim();
  if (!query) {
    process.stderr.write("Kullanim: cor search <kelime>\n");
    return 1;
  }

  const matches = searchCatalog(await fetchCatalog(loadConfig()), query).slice(0, 40);
  if (matches.length === 0) {
    process.stdout.write(`'${query}' icin sonuc yok.\n`);
    return 0;
  }
  for (const model of matches) {
    const context = model.contextLength
      ? ` (${model.contextLength.toLocaleString("tr-TR")} token)`
      : "";
    process.stdout.write(`${model.id}${context}\n  ${model.name ?? ""}\n`);
  }
  return 0;
}

function commandSync(args: string[]): number {
  if (args.includes("--revert")) {
    const { path, restored } = revertModelPicker();
    process.stdout.write(
      restored ? `Geri alindi: ${path}\n` : `Geri alinacak bir sey yok: ${path}\n`,
    );
    return 0;
  }

  const config = loadConfig();
  const { path, removed } = syncModelPicker(config.models);
  if (removed) {
    process.stdout.write(`Model listesi bos oldugu icin modelPicker kaldirildi: ${path}\n`);
    return 0;
  }
  process.stdout.write(`${config.models.length} model /model menusune yazildi: ${path}\n`);
  process.stdout.write(`Yedek: ${backupPath()}\n`);
  return 0;
}

async function commandStart(): Promise<number> {
  const { port, alreadyRunning } = await startProxy();
  process.stdout.write(
    alreadyRunning
      ? `Proxy zaten calisiyor: http://127.0.0.1:${port}\n`
      : `Proxy basladi: http://127.0.0.1:${port}\nLog: ${logPath()}\n`,
  );
  return 0;
}

function commandStop(): number {
  process.stdout.write(stopProxy() ? "Proxy durduruldu.\n" : "Calisan proxy yok.\n");
  return 0;
}

async function commandStatus(): Promise<number> {
  const config = loadConfig();
  const pid = readPid();
  const answering = await isPortAnswering(config.port);

  process.stdout.write(`Port:    ${config.port}\n`);
  process.stdout.write(`Proxy:   ${answering ? "calisiyor" : "kapali"}`);
  if (pid) process.stdout.write(` (pid ${pid}${isRunning(pid) ? "" : ", olu"})`);
  process.stdout.write("\n");
  process.stdout.write(`Anahtar: ${resolveOpenRouterKey(config) ? "var" : "YOK"}\n`);
  process.stdout.write(`Model:   ${config.models.length} ekli\n`);
  return answering ? 0 : 1;
}

async function commandDoctor(): Promise<number> {
  const config = loadConfig();
  let problems = 0;

  const check = (ok: boolean, label: string, hint?: string): void => {
    process.stdout.write(`${ok ? "[ok]" : "[!!]"} ${label}\n`);
    if (!ok) {
      problems++;
      if (hint) process.stdout.write(`     -> ${hint}\n`);
    }
  };

  check(Boolean(resolveOpenRouterKey(config)), "OpenRouter anahtari", "cor key <anahtar>");
  check(config.models.length > 0, "Ekli model", "cor add <model-id>");

  let settingsOk = false;
  let optionCount = 0;
  try {
    const picker = readClaudeSettings().modelPicker as { options?: unknown[] } | undefined;
    optionCount = picker?.options?.length ?? 0;
    settingsOk = optionCount === config.models.length && optionCount > 0;
  } catch (err) {
    process.stdout.write(`     ${(err as Error).message}\n`);
  }
  check(
    settingsOk,
    `${claudeSettingsPath()} icindeki modelPicker (${optionCount} satir)`,
    "cor sync",
  );

  check(await isPortAnswering(config.port), `Proxy 127.0.0.1:${config.port}`, "cor start");

  if (resolveOpenRouterKey(config)) {
    try {
      await fetchCatalog(config);
      check(true, "OpenRouter erisimi");
    } catch (err) {
      check(false, `OpenRouter erisimi: ${(err as Error).message}`);
    }
  }

  const claudeFound = await hasClaudeCli();
  check(claudeFound, "claude komutu PATH'te", "Claude Code kurulu mu?");

  process.stdout.write(problems === 0 ? "\nHer sey hazir.\n" : `\n${problems} sorun var.\n`);
  return problems === 0 ? 0 : 1;
}

function hasClaudeCli(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = spawn("claude", ["--version"], { stdio: "ignore" });
    probe.on("error", () => resolve(false));
    probe.on("exit", (code) => resolve(code === 0));
  });
}

async function commandClaude(args: string[]): Promise<number> {
  const config = loadConfig();
  const { port } = await startProxy();

  if (config.models.length > 0 && !existsSync(backupPath())) {
    process.stderr.write("Not: 'cor sync' henuz calistirilmadi, /model menusunde gorunmeyebilir.\n");
  }

  // Claude Code assumes 200K for ids it doesn't recognize. The smallest
  // configured window is the safe assumption, since the variable is read once
  // at startup and can't follow a mid-session model switch.
  const windows = config.models
    .map((model) => model.contextTokens)
    .filter((value): value is number => typeof value === "number" && value > 0);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
  };
  if (windows.length > 0) {
    env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(Math.min(...windows));
  }

  return new Promise((resolve) => {
    // stdio is inherited so the Claude Code interface behaves exactly as usual.
    const child = spawn("claude", args, { stdio: "inherit", env });
    child.on("error", (err) => {
      process.stderr.write(`claude calistirilamadi: ${err.message}\n`);
      resolve(1);
    });
    child.on("exit", (code, signal) => resolve(signal ? 1 : (code ?? 0)));
  });
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`Hata: ${(err as Error).message}\n`);
    process.exitCode = 1;
  });
