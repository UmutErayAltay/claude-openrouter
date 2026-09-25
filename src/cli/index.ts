import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  configPath,
  findModel,
  keyPath,
  loadConfig,
  logPath,
  migrateLegacyKey,
  resolveOpenRouterKey,
  saveConfig,
  saveKey,
} from "../config.js";
import {
  backupPath,
  claudeSettingsPath,
  readClaudeSettings,
  revertModelPicker,
  syncModelPicker,
} from "../claudeSettings.js";
import { fetchCatalog, fetchEndpoints, searchCatalog } from "../openrouterCatalog.js";
import { isPortAnswering, isRunning, readPid, startProxy, stopProxy } from "../proxyProcess.js";
import { writeAgent } from "../agentTemplate.js";
import {
  ModelOpError,
  addModel,
  removeModel,
  validateModelEntry,
  type ModelInput,
} from "../modelOps.js";
import { HELP } from "./help.js";

async function main(argv: string[]): Promise<number> {
  migrateLegacyKey();
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
    case "dashboard":
      return commandDashboard();
    case "stop":
      return commandStop();
    case "status":
      return commandStatus();
    case "doctor":
      return commandDoctor();
    case "agent":
      return commandAgent(rest);
    case "providers":
      return commandProviders(rest);
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
  saveKey(key);
  process.stdout.write(`Anahtar kaydedildi: ${keyPath()} (izin 0600)\n`);
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
      reasoning: { type: "string" },
      cheapest: { type: "boolean" },
      sort: { type: "string" },
      "max-price-in": { type: "string" },
      "max-price-out": { type: "string" },
      quantizations: { type: "string" },
    },
  });

  const id = positionals[0];
  if (!id) {
    process.stderr.write("Kullanim: cor add <model-id>  (ornek: cor add openai/gpt-5)\n");
    return 1;
  }

  const input: ModelInput = {
    label: values.label,
    description: values.description,
    contextTokens: values.context ? Number(values.context) : undefined,
    maxOutputTokens: values["max-tokens"] ? Number(values["max-tokens"]) : undefined,
    behavesAs: values["behaves-as"],
    stream: values["no-stream"] ? false : values.stream ? true : undefined,
    reasoning: values.reasoning,
    providerSort: values.cheapest ? "price" : values.sort,
    maxPrice:
      values["max-price-in"] || values["max-price-out"]
        ? {
            ...(values["max-price-in"] ? { prompt: Number(values["max-price-in"]) } : {}),
            ...(values["max-price-out"] ? { completion: Number(values["max-price-out"]) } : {}),
          }
        : undefined,
    quantizations: values.quantizations
      ? values.quantizations.split(",").map((q) => q.trim()).filter(Boolean)
      : undefined,
  };

  const config = loadConfig();
  let result;
  try {
    result = await addModel(config, id, input);
  } catch (err) {
    const message = (err as Error).message;
    const hint = err instanceof ModelOpError && message.endsWith("zaten ekli.")
      ? ` Once 'cor remove ${id}' calistir.`
      : "";
    process.stderr.write(`${message}${hint}\n`);
    return 1;
  }

  if (result.status === "not_found") {
    process.stderr.write(
      `Uyari: '${id}' OpenRouter katalogunda bulunamadi. 'cor search' ile dogru ID'yi arayabilirsin.\n`,
    );
  } else if (result.status === "catalog_error") {
    process.stderr.write(`Uyari: katalog alinamadi (${result.errorMessage}).\n`);
  }

  saveConfig(config);

  process.stdout.write(`Eklendi: ${result.entry.label ?? result.entry.id} (${result.entry.id})\n`);
  process.stdout.write("Simdi 'cor sync' calistirip /model menusune yansit.\n");
  return 0;
}

async function commandProviders(args: string[]): Promise<number> {
  const config = loadConfig();
  const id = args[0] ?? config.models[0]?.id;
  if (!id) {
    process.stderr.write("Kullanim: cor providers <model-id>\n");
    return 1;
  }

  const endpoints = await fetchEndpoints(config, id);
  if (endpoints.length === 0) {
    process.stdout.write(`${id} icin saglayici bulunamadi.\n`);
    return 1;
  }

  process.stdout.write(`${id} - ${endpoints.length} saglayici (ucuzdan pahaliya)\n\n`);
  process.stdout.write(
    `${"saglayici".padEnd(24)}${"girdi $/M".padStart(11)}${"cikti $/M".padStart(11)}` +
      `${"kuantizasyon".padStart(14)}${"baglam".padStart(12)}\n`,
  );
  for (const endpoint of endpoints) {
    process.stdout.write(
      endpoint.providerName.padEnd(24) +
        endpoint.promptPrice.toFixed(3).padStart(11) +
        endpoint.completionPrice.toFixed(3).padStart(11) +
        (endpoint.quantization ?? "-").padStart(14) +
        (endpoint.contextLength ?? 0).toLocaleString("tr-TR").padStart(12) +
        "\n",
    );
  }

  const cheapest = endpoints[0];
  const dearest = endpoints[endpoints.length - 1];
  if (cheapest && dearest && cheapest.promptPrice > 0) {
    const ratio = dearest.promptPrice / cheapest.promptPrice;
    process.stdout.write(`\nEn pahali, en ucuzun ${ratio.toFixed(1)} kati.\n`);
    process.stdout.write("Hep en ucuzu icin: cor add <model-id> --cheapest\n");
  }
  return 0;
}

function commandAgent(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      name: { type: "string" },
      scope: { type: "string" },
    },
  });

  const config = loadConfig();
  const id = positionals[0] ?? config.models[0]?.id;
  if (!id) {
    process.stderr.write(
      "Once bir model ekle: cor add <model-id>\nKullanim: cor agent [model-id] [--name <ad>] [--scope project|user]\n",
    );
    return 1;
  }

  const entry = findModel(config, id);
  if (!entry) {
    process.stderr.write(`${id} ekli degil. Once 'cor add ${id}' calistir.\n`);
    return 1;
  }

  const scope = values.scope === "user" ? "user" : "project";
  const { path, overwritten } = writeAgent({
    name: values.name ?? "dosya-kodcu",
    modelId: entry.id,
    scope,
    label: entry.label,
  });

  process.stdout.write(`${overwritten ? "Guncellendi" : "Olusturuldu"}: ${path}\n`);
  process.stdout.write(
    "Claude Code'da Opus ile plan yap, sonra uygulamayi bu alt ajana ver:\n" +
      `  "<plan> - bunu src/foo.ts dosyasina uygula, ${values.name ?? "dosya-kodcu"} alt ajanini kullan"\n`,
  );
  return 0;
}

function commandRemove(args: string[]): number {
  const id = args[0];
  if (!id) {
    process.stderr.write("Kullanim: cor remove <model-id>\n");
    return 1;
  }
  const config = loadConfig();
  if (!removeModel(config, id)) {
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
    const reasoning = model.reasoning ? `, reasoning: ${model.reasoning}` : "";
    const sort = model.providerSort ? `, saglayici: ${model.providerSort}` : "";
    const stream = model.stream === false ? ", akissiz" : "";
    process.stdout.write(`${model.id}\n  ${model.label ?? model.id}${context}${reasoning}${sort}${stream}\n`);
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

async function commandDashboard(): Promise<number> {
  const { port } = await startProxy();
  const url = `http://127.0.0.1:${port}/dashboard`;
  // Printed before the open attempt: this often runs in a headless
  // container, and the URL is the only thing that matters if opening fails.
  process.stdout.write(`Dashboard: ${url}\n`);

  const openCommand =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(openCommand, [url], { detached: true, stdio: "ignore" });
    // A missing binary (common on Linux without a desktop environment) fails
    // asynchronously; a plain try/catch around spawn() would not catch it.
    child.on("error", () => {});
    child.unref();
  } catch {
    // Opening is best-effort; the URL above is already enough.
  }

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
  check(
    !config.openrouterApiKey,
    "config.json'da eski anahtar alani yok",
    `Anahtar hala config.json icinde; otomatik tasima basarisiz olmus olabilir. ` +
      `cor key <anahtar> ile yeniden kaydet, sonra config.json'daki openrouterApiKey alanini elle sil.`,
  );
  check(config.models.length > 0, "Ekli model", "cor add <model-id>");

  for (const model of config.models) {
    const problems = validateModelEntry(model);
    check(problems.length === 0, `${model.id}: config gecerli`, problems.join(" "));
  }

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
