import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isProviderSort,
  isQuantization,
  isReasoningEffort,
  QUANTIZATIONS,
  configPath,
  findModel,
  keyPath,
  keySource,
  listConfigHistory,
  loadConfig,
  markModelNonStreaming,
  migrateLegacyKey,
  resolveOpenRouterKey,
  restoreConfig,
  saveConfig,
  saveKey,
  validateSettings,
  DEFAULT_CONFIG,
  type Config,
} from "../src/config.js";

let dir: string;
const originalDir = process.env.CLAUDE_OPENROUTER_DIR;
const originalKey = process.env.OPENROUTER_API_KEY;

/**
 * NTFS has no POSIX permission bits, so on Windows `fs.stat().mode` reports
 * something like 0o666 regardless of what mode `writeFileSync`/`chmodSync`
 * were given (a real difference, caught by CI's Windows job — not something
 * this project's code can fix, since Node's fs module doesn't map onto NTFS
 * ACLs). Assert the real guarantee only where the platform can provide it.
 */
function expectOwnerOnlyMode(path: string): void {
  if (process.platform === "win32") return;
  expect(statSync(path).mode & 0o777).toBe(0o600);
}

/** Round-trips a raw object through a written config.json, as a stored one would. */
function loadStoredConfig(stored: Record<string, unknown>) {
  writeFileSync(configPath(), JSON.stringify(stored));
  return loadConfig();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cor-config-"));
  process.env.CLAUDE_OPENROUTER_DIR = dir;
  delete process.env.OPENROUTER_API_KEY;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (originalDir === undefined) delete process.env.CLAUDE_OPENROUTER_DIR;
  else process.env.CLAUDE_OPENROUTER_DIR = originalDir;
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
});

describe("loadConfig", () => {
  it("returns defaults when there is no config file", () => {
    expect(loadConfig()).toEqual({ ...DEFAULT_CONFIG, models: [] });
  });

  it("round-trips a saved config", () => {
    saveConfig({ ...DEFAULT_CONFIG, port: 9000, models: [{ id: "openai/gpt-5" }] });

    const config = loadConfig();
    expect(config.port).toBe(9000);
    expect(config.models).toEqual([{ id: "openai/gpt-5" }]);
  });

  it("stores the API key so only the owner can read it", () => {
    saveConfig({ ...DEFAULT_CONFIG, openrouterApiKey: "sk-or-secret" });
    expectOwnerOnlyMode(configPath());
  });

  it("never writes the key into config.json, even when the caller passes one", () => {
    saveConfig({ ...DEFAULT_CONFIG, openrouterApiKey: "sk-or-secret", port: 9001 });
    expect(readFileSync(configPath(), "utf8")).not.toContain("sk-or-secret");
    expect(readFileSync(configPath(), "utf8")).not.toContain("openrouterApiKey");
    expect(loadConfig().port).toBe(9001);
  });

  it("drops entries without an id and trailing slashes on base urls", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        openrouterBaseUrl: "https://example.test/api/v1/",
        models: [{ id: "openai/gpt-5" }, { label: "id yok" }, "metin"],
      }),
    );

    const config = loadConfig();
    expect(config.openrouterBaseUrl).toBe("https://example.test/api/v1");
    expect(config.models).toEqual([{ id: "openai/gpt-5" }]);
  });

  it("names the file when its JSON is broken", () => {
    writeFileSync(configPath(), "{ bozuk");
    expect(() => loadConfig()).toThrow(/gecerli JSON degil/);
  });
});

describe("resolveOpenRouterKey", () => {
  it("prefers the environment variable over the legacy config field", () => {
    const config = { ...DEFAULT_CONFIG, openrouterApiKey: "config-eskisi" };
    expect(resolveOpenRouterKey(config)).toBe("config-eskisi");

    process.env.OPENROUTER_API_KEY = "ortamdan";
    expect(resolveOpenRouterKey(config)).toBe("ortamdan");
  });

  it("prefers the key file over the legacy config field", () => {
    saveKey("dosyadan");
    const config = { ...DEFAULT_CONFIG, openrouterApiKey: "config-eskisi" };
    expect(resolveOpenRouterKey(config)).toBe("dosyadan");
  });

  it("prefers the environment variable over the key file", () => {
    saveKey("dosyadan");
    process.env.OPENROUTER_API_KEY = "ortamdan";
    expect(resolveOpenRouterKey(DEFAULT_CONFIG)).toBe("ortamdan");
  });
});

describe("saveKey / keyPath", () => {
  it("writes the key to its own file with 0600 permissions, separate from config.json", () => {
    saveKey("sk-or-secret");
    expect(readFileSync(keyPath(), "utf8").trim()).toBe("sk-or-secret");
    expectOwnerOnlyMode(keyPath());
  });

  it("overwrites a previously saved key", () => {
    saveKey("ilk");
    saveKey("ikinci");
    expect(readFileSync(keyPath(), "utf8").trim()).toBe("ikinci");
  });
});

describe("migrateLegacyKey", () => {
  it("moves a key from config.json into the key file and strips it from config.json", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ ...DEFAULT_CONFIG, openrouterApiKey: "eski-anahtar" }),
    );

    expect(migrateLegacyKey()).toBe(true);
    expect(readFileSync(keyPath(), "utf8").trim()).toBe("eski-anahtar");
    expect(readFileSync(configPath(), "utf8")).not.toContain("eski-anahtar");
    expect(resolveOpenRouterKey(loadConfig())).toBe("eski-anahtar");
  });

  it("is a no-op the second time (already migrated)", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ ...DEFAULT_CONFIG, openrouterApiKey: "eski-anahtar" }),
    );
    expect(migrateLegacyKey()).toBe(true);
    expect(migrateLegacyKey()).toBe(false);
  });

  it("is a no-op when there was never a legacy key", () => {
    saveConfig({ ...DEFAULT_CONFIG });
    expect(migrateLegacyKey()).toBe(false);
  });

  it("does not overwrite a newer key file with a stale legacy field", () => {
    saveKey("guncel-anahtar");
    writeFileSync(
      configPath(),
      JSON.stringify({ ...DEFAULT_CONFIG, openrouterApiKey: "eski-anahtar" }),
    );

    migrateLegacyKey();
    expect(readFileSync(keyPath(), "utf8").trim()).toBe("guncel-anahtar");
    expect(readFileSync(configPath(), "utf8")).not.toContain("eski-anahtar");
  });
});

describe("keySource", () => {
  it("reports none, then config, then file, then env, in priority order", () => {
    expect(keySource(DEFAULT_CONFIG)).toBe("none");

    const withLegacyKey = { ...DEFAULT_CONFIG, openrouterApiKey: "eski" };
    expect(keySource(withLegacyKey)).toBe("config");

    saveKey("dosyadan");
    expect(keySource(withLegacyKey)).toBe("file");

    process.env.OPENROUTER_API_KEY = "ortamdan";
    expect(keySource(withLegacyKey)).toBe("env");
  });
});

describe("findModel", () => {
  it("matches on the exact id", () => {
    const config = { ...DEFAULT_CONFIG, models: [{ id: "openai/gpt-5" }] };
    expect(findModel(config, "openai/gpt-5")).toEqual({ id: "openai/gpt-5" });
    expect(findModel(config, "openai/gpt-4o")).toBeUndefined();
  });
});

describe("markModelNonStreaming", () => {
  it("sets stream:false and flags it as auto-recovered", () => {
    saveConfig({ ...DEFAULT_CONFIG, models: [{ id: "x" }] });

    expect(markModelNonStreaming("x")).toBe(true);
    expect(loadConfig().models[0]).toEqual({ id: "x", stream: false, autoRecovered: true });
  });

  it("returns false and changes nothing for a model already non-streaming", () => {
    saveConfig({ ...DEFAULT_CONFIG, models: [{ id: "x", stream: false }] });

    expect(markModelNonStreaming("x")).toBe(false);
    expect(loadConfig().models[0]).toEqual({ id: "x", stream: false });
  });

  it("returns false for a model that isn't configured", () => {
    saveConfig({ ...DEFAULT_CONFIG, models: [] });
    expect(markModelNonStreaming("missing")).toBe(false);
  });
});

describe("isReasoningEffort", () => {
  it("accepts the values OpenRouter takes and rejects the rest", () => {
    for (const value of ["none", "low", "medium", "high", "max"]) {
      expect(isReasoningEffort(value)).toBe(true);
    }
    expect(isReasoningEffort("xhigh")).toBe(false);
    expect(isReasoningEffort("")).toBe(false);
  });
});

describe("isProviderSort", () => {
  it("accepts the sort keys OpenRouter takes", () => {
    for (const value of ["price", "throughput", "latency"]) {
      expect(isProviderSort(value)).toBe(true);
    }
    expect(isProviderSort("cheapest")).toBe(false);
  });
});

describe("isQuantization", () => {
  it("accepts every value in QUANTIZATIONS and rejects the rest", () => {
    for (const value of QUANTIZATIONS) {
      expect(isQuantization(value)).toBe(true);
    }
    expect(isQuantization("fp99")).toBe(false);
    // A single space-separated string, the shape the historical bug produced.
    expect(isQuantization("fp8 bf16 fp16")).toBe(false);
    expect(isQuantization("")).toBe(false);
  });
});

describe("budget and alerts parsing", () => {
  it("keeps a well-formed budget", () => {
    const config = loadStoredConfig({
      budget: { dailyUsd: 10, monthlyUsd: 200, action: "block" },
    });
    expect(config.budget).toEqual({ dailyUsd: 10, monthlyUsd: 200, action: "block" });
  });

  it("defaults an unknown budget action to warn instead of failing the load", () => {
    const config = loadStoredConfig({ budget: { dailyUsd: 10, action: "shutdown" } });
    expect(config.budget).toEqual({ dailyUsd: 10, monthlyUsd: undefined, action: "warn" });
  });

  it("silently drops a budget number that isn't a usable figure", () => {
    for (const bad of [-1, "10", null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(loadStoredConfig({ budget: { dailyUsd: bad, monthlyUsd: 20 } }).budget).toEqual({
        dailyUsd: undefined,
        monthlyUsd: 20,
        action: "warn",
      });
    }
  });

  it("leaves budget unset when nothing in it survives", () => {
    for (const bad of [{ dailyUsd: "10" }, { dailyUsd: -5 }, {}, "metin", null]) {
      expect(loadStoredConfig({ budget: bad }).budget).toBeUndefined();
    }
  });

  it("keeps a well-formed alerts section", () => {
    const config = loadStoredConfig({
      alerts: {
        errorRatePct: 25,
        latencyP95Seconds: 30,
        windowMinutes: 15,
        webhookUrl: "https://hooks.example.test/cor",
      },
    });
    expect(config.alerts).toEqual({
      errorRatePct: 25,
      latencyP95Seconds: 30,
      windowMinutes: 15,
      webhookUrl: "https://hooks.example.test/cor",
    });
  });

  it("silently drops each malformed alert field on its own", () => {
    const config = loadStoredConfig({
      alerts: { errorRatePct: -1, latencyP95Seconds: "30", windowMinutes: Number.NaN, webhookUrl: 5 },
    });
    // Nothing survives, so the section is left unset rather than kept as an
    // object of undefineds.
    expect(config.alerts).toBeUndefined();
  });

  it("keeps the valid half of an alerts section when the other half is malformed", () => {
    const config = loadStoredConfig({
      alerts: { errorRatePct: 25, windowMinutes: "15", webhookUrl: "not a url" },
    });
    expect(config.alerts).toEqual({
      errorRatePct: 25,
      latencyP95Seconds: undefined,
      windowMinutes: undefined,
      webhookUrl: undefined,
    });
  });

  it("drops a webhook that isn't an http(s) address", () => {
    for (const bad of ["", "not a url", "javascript:alert(1)", "ftp://example.test", 42]) {
      const config = loadStoredConfig({ alerts: { errorRatePct: 10, webhookUrl: bad } });
      expect(config.alerts).toEqual({
        errorRatePct: 10,
        latencyP95Seconds: undefined,
        windowMinutes: undefined,
        webhookUrl: undefined,
      });
    }
  });

  it("leaves alerts unset when nothing in it survives", () => {
    for (const bad of [{ errorRatePct: "25" }, { webhookUrl: "ftp://example.test" }, {}, "metin", null]) {
      expect(loadStoredConfig({ alerts: bad }).alerts).toBeUndefined();
    }
  });

  it("still loads the rest of the config when a stored section is malformed", () => {
    const config = loadStoredConfig({ port: 9100, budget: { dailyUsd: "cok" }, models: [{ id: "x" }] });
    expect(config.port).toBe(9100);
    expect(config.models).toEqual([{ id: "x" }]);
    expect(config.budget).toBeUndefined();
  });
});

describe("validateSettings", () => {
  it("returns nothing for an empty body, so a section left out stays unset", () => {
    expect(validateSettings({})).toEqual({});
  });

  it("defaults the budget action to warn when it's absent", () => {
    expect(validateSettings({ budget: { dailyUsd: 5 } })).toEqual({
      budget: { dailyUsd: 5, monthlyUsd: undefined, action: "warn" },
    });
  });

  it("accepts zero as a real cap rather than treating it as missing", () => {
    expect(validateSettings({ budget: { dailyUsd: 0, monthlyUsd: 0, action: "block" } })).toEqual({
      budget: { dailyUsd: 0, monthlyUsd: 0, action: "block" },
    });
  });

  it("rejects a negative number, naming the field", () => {
    expect(() => validateSettings({ budget: { dailyUsd: -1 } })).toThrow(/budget\.dailyUsd/);
    expect(() => validateSettings({ budget: { monthlyUsd: -0.01 } })).toThrow(/budget\.monthlyUsd/);
    expect(() => validateSettings({ alerts: { errorRatePct: -5 } })).toThrow(/alerts\.errorRatePct/);
    expect(() => validateSettings({ alerts: { latencyP95Seconds: -1 } })).toThrow(
      /alerts\.latencyP95Seconds/,
    );
  });

  it("rejects a number that isn't one", () => {
    expect(() => validateSettings({ budget: { dailyUsd: "10" } })).toThrow(/budget\.dailyUsd/);
    expect(() => validateSettings({ alerts: { windowMinutes: Number.NaN } })).toThrow(
      /alerts\.windowMinutes/,
    );
  });

  it("rejects an action that isn't warn or block", () => {
    expect(() => validateSettings({ budget: { action: "shutdown" } })).toThrow(/budget action/);
    expect(() => validateSettings({ budget: { action: 1 } })).toThrow(/budget action/);
  });

  it("clears the webhook on an empty string", () => {
    expect(validateSettings({ alerts: { webhookUrl: "" } }).alerts?.webhookUrl).toBeUndefined();
    expect(validateSettings({ alerts: { webhookUrl: null } }).alerts?.webhookUrl).toBeUndefined();
  });

  it("rejects a webhook that isn't an http(s) address", () => {
    for (const bad of ["not a url", "javascript:alert(1)", "ftp://example.test", 42]) {
      expect(() => validateSettings({ alerts: { webhookUrl: bad } })).toThrow(/alerts\.webhookUrl/);
    }
  });

  it("rejects a section that isn't an object", () => {
    expect(() => validateSettings("metin")).toThrow(/JSON nesnesi/);
    expect(() => validateSettings({ budget: "metin" })).toThrow(/Budget bir JSON nesnesi/);
    expect(() => validateSettings({ alerts: 7 })).toThrow(/Alerts bir JSON nesnesi/);
  });
});

describe("config history", () => {
  // A snapshot is named after the millisecond it was taken, so two saves inside
  // the same millisecond would collide on one filename. Tick the clock between
  // writes to keep each save a distinct version; the collision itself is
  // covered by its own test below.
  let tick = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    tick = 0;
    vi.setSystemTime(new Date("2026-09-26T12:00:00Z").getTime());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function saveVersioned(config: Config): void {
    tick += 1;
    vi.setSystemTime(new Date("2026-09-26T12:00:00Z").getTime() + tick);
    saveConfig(config);
  }

  it("has no history until a config has been overwritten", () => {
    saveVersioned({ ...DEFAULT_CONFIG });
    expect(listConfigHistory()).toEqual([]);
  });

  it("snapshots the config being replaced, starting from the second save", () => {
    saveVersioned({ ...DEFAULT_CONFIG, port: 9000 });
    expect(listConfigHistory()).toEqual([]);

    saveVersioned({ ...DEFAULT_CONFIG, port: 9001 });

    const history = listConfigHistory();
    expect(history).toHaveLength(1);
    const snapshot = join(dir, "history", history[0]?.file ?? "");
    expect(readFileSync(snapshot, "utf8")).toContain('"port": 9000');
    expect(loadConfig().port).toBe(9001);
  });

  it("keeps each snapshot owner-only", () => {
    saveVersioned({ ...DEFAULT_CONFIG, port: 9000 });
    saveVersioned({ ...DEFAULT_CONFIG, port: 9001 });

    const file = listConfigHistory()[0]?.file ?? "";
    expectOwnerOnlyMode(join(dir, "history", file));
  });

  it("keeps at most 20 snapshots", () => {
    saveVersioned({ ...DEFAULT_CONFIG, port: 9000 });
    for (let i = 1; i <= 25; i++) {
      saveVersioned({ ...DEFAULT_CONFIG, port: 9000 + i });
    }

    expect(listConfigHistory()).toHaveLength(20);
    // The oldest surviving snapshot is the one taken before port 9006.
    const oldest = readFileSync(join(dir, "history", listConfigHistory().at(-1)?.file ?? ""), "utf8");
    expect(oldest).toContain('"port": 9005');
  });

  // Same-millisecond saves (a dashboard edit right after a restore) get a
  // numeric suffix instead of overwriting each other's snapshot.
  it("keeps every version saved inside a single millisecond", () => {
    saveConfig({ ...DEFAULT_CONFIG, port: 9000 });
    saveConfig({ ...DEFAULT_CONFIG, port: 9001 });
    saveConfig({ ...DEFAULT_CONFIG, port: 9002 });

    // The first save has nothing to snapshot, so three saves leave two versions.
    expect(listConfigHistory()).toHaveLength(2);
  });

  it("lists the newest snapshot first", () => {
    saveVersioned({ ...DEFAULT_CONFIG, port: 9000 });
    saveVersioned({ ...DEFAULT_CONFIG, port: 9001 });
    saveVersioned({ ...DEFAULT_CONFIG, port: 9002 });

    // The first save has nothing to snapshot, so three saves leave two versions.
    const history = listConfigHistory();
    expect(history).toHaveLength(2);
    expect((history[0]?.savedAt ?? "") >= (history[1]?.savedAt ?? "")).toBe(true);
    expect((history[0]?.file ?? "") > (history[1]?.file ?? "")).toBe(true);
    expect(history[0]?.savedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.\d{3}Z$/);
  });

  it("reports the model count and size of each snapshot", () => {
    saveVersioned({ ...DEFAULT_CONFIG, models: [{ id: "a" }] });
    saveVersioned({ ...DEFAULT_CONFIG, models: [{ id: "a" }, { id: "b" }, { id: "c" }] });

    const history = listConfigHistory();
    expect(history).toHaveLength(1);
    expect(history[0]?.models).toBe(1);
    expect(history[0]?.size).toBeGreaterThan(0);
  });

  it("never copies the API key into a snapshot", () => {
    saveVersioned({ ...DEFAULT_CONFIG, openrouterApiKey: "sk-or-gizli", port: 9000 });
    saveVersioned({ ...DEFAULT_CONFIG, openrouterApiKey: "sk-or-gizli", port: 9001 });

    const file = listConfigHistory()[0]?.file ?? "";
    const snapshot = readFileSync(join(dir, "history", file), "utf8");
    expect(snapshot).not.toContain("sk-or-gizli");
    expect(snapshot).not.toContain("openrouterApiKey");
  });
});

describe("restoreConfig", () => {
  let tick = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    tick = 0;
    vi.setSystemTime(new Date("2026-09-26T12:00:00Z").getTime());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function saveVersioned(config: Config): void {
    tick += 1;
    vi.setSystemTime(new Date("2026-09-26T12:00:00Z").getTime() + tick);
    saveConfig(config);
  }

  function saveThreeVersions(): string[] {
    saveVersioned({ ...DEFAULT_CONFIG, port: 9000, models: [{ id: "ilk" }] });
    saveVersioned({ ...DEFAULT_CONFIG, port: 9001, models: [{ id: "ikinci" }] });
    saveVersioned({ ...DEFAULT_CONFIG, port: 9002, models: [{ id: "ucuncu" }] });
    return listConfigHistory().map((entry) => entry.file);
  }

  it("brings a snapshot back as the live config", () => {
    const history = saveThreeVersions();
    const oldest = history[history.length - 1] ?? "";

    const restored = restoreConfig(oldest);

    expect(restored.port).toBe(9000);
    expect(restored.models).toEqual([{ id: "ilk" }]);
    expect(loadConfig().models).toEqual([{ id: "ilk" }]);
  });

  it("snapshots what it replaced, so an undo is itself undoable", () => {
    const history = saveThreeVersions();
    const before = listConfigHistory().length;

    restoreConfig(history[history.length - 1] ?? "");

    const after = listConfigHistory();
    expect(after.length).toBe(before + 1);
    // The newest entry is the config the restore replaced ("ucuncu"), even
    // though it was written in the same millisecond as the previous snapshot.
    expect(history).not.toContain(after[0]?.file);
    expect(after[0]?.models).toBe(1);
  });

  it("rejects a name that tries to climb out of the history directory", () => {
    expect(() => restoreConfig("../config.json")).toThrow(/Gecersiz config dosya adi/);
  });

  it("rejects a nested path", () => {
    expect(() => restoreConfig("a/b.json")).toThrow(/Gecersiz config dosya adi/);
  });

  it("rejects an empty name", () => {
    expect(() => restoreConfig("")).toThrow(/Eski config dosya adi zorunlu/);
  });

  it("rejects a name that isn't a .json file", () => {
    expect(() => restoreConfig("config.json.tmp")).toThrow(/Gecersiz config dosya adi/);
  });

  it("reports a snapshot that isn't there", () => {
    expect(() => restoreConfig("2020-01-01T00-00-00.000Z.json")).toThrow(/Config gecmisi bulunamadi/);
  });

  it("never writes a key into the restored config file", () => {
    saveVersioned({ ...DEFAULT_CONFIG, openrouterApiKey: "sk-or-gizli", port: 9000 });
    saveVersioned({ ...DEFAULT_CONFIG, openrouterApiKey: "sk-or-gizli", port: 9001 });
    const oldest = listConfigHistory()[0]?.file ?? "";

    restoreConfig(oldest);

    expect(readFileSync(configPath(), "utf8")).not.toContain("sk-or-gizli");
    expect(readFileSync(configPath(), "utf8")).not.toContain("openrouterApiKey");
  });
});
