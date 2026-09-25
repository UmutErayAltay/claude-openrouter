import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  loadConfig,
  markModelNonStreaming,
  migrateLegacyKey,
  resolveOpenRouterKey,
  saveConfig,
  saveKey,
  DEFAULT_CONFIG,
} from "../src/config.js";

let dir: string;
const originalDir = process.env.CLAUDE_OPENROUTER_DIR;
const originalKey = process.env.OPENROUTER_API_KEY;

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
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
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
    expect(statSync(keyPath()).mode & 0o777).toBe(0o600);
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
