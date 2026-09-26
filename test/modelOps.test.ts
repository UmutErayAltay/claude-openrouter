import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type Config } from "../src/config.js";
import {
  ModelOpError,
  addModel,
  autofillFromCatalog,
  buildModelEntry,
  checkFreeTierDrift,
  mergeModelEntry,
  removeModel,
  type FreeTierDrift,
  updateModel,
  validateModelEntry,
} from "../src/modelOps.js";
import type { CatalogModel } from "../src/openrouterCatalog.js";

function config(models: Config["models"] = [], overrides: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, models, ...overrides };
}

/** A tiny fake catalog server so autofill/addModel can be tested without the network. */
let catalog: Server;
let catalogUrl: string;

beforeAll(async () => {
  catalog = createServer((req, res) => {
    if (req.url === "/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: [
            {
              id: "openai/gpt-5",
              name: "GPT-5",
              description: "Hizli bir model. Ikinci cumle.",
              context_length: 400000,
              top_provider: { max_completion_tokens: 64000 },
            },
          ],
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => catalog.listen(0, "127.0.0.1", resolve));
  catalogUrl = `http://127.0.0.1:${(catalog.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => catalog.close(() => resolve()));
});

describe("buildModelEntry", () => {
  it("builds a minimal entry from just an id", () => {
    expect(buildModelEntry("openai/gpt-5")).toEqual({ id: "openai/gpt-5" });
  });

  it("sets every recognized field", () => {
    const entry = buildModelEntry("openai/gpt-5", {
      label: "GPT-5",
      description: "hizli",
      contextTokens: 400000,
      maxOutputTokens: 64000,
      behavesAs: "claude-sonnet-5",
      stream: false,
      reasoning: "high",
      providerSort: "price",
      maxPrice: { prompt: 1, completion: 2 },
      quantizations: ["fp8"],
    });

    expect(entry).toEqual({
      id: "openai/gpt-5",
      label: "GPT-5",
      description: "hizli",
      contextTokens: 400000,
      maxOutputTokens: 64000,
      behavesAs: "claude-sonnet-5",
      stream: false,
      reasoning: "high",
      providerSort: "price",
      maxPrice: { prompt: 1, completion: 2 },
      quantizations: ["fp8"],
    });
  });

  it("rejects an invalid reasoning value", () => {
    expect(() => buildModelEntry("x", { reasoning: "ultra" })).toThrow(ModelOpError);
    expect(() => buildModelEntry("x", { reasoning: "ultra" })).toThrow(/Gecersiz reasoning/);
  });

  it("rejects an invalid sort value", () => {
    expect(() => buildModelEntry("x", { providerSort: "cheapest" })).toThrow(ModelOpError);
  });

  it("leaves empty quantizations unset", () => {
    expect(buildModelEntry("x", { quantizations: [] })).toEqual({ id: "x" });
  });

  it("splits a single space-separated quantizations argument instead of storing it whole", () => {
    // The exact historical bug: `--quantizations "fp8 bf16 fp16"` arrives as
    // CLI/dashboard code split only on comma → one element, ["fp8 bf16 fp16"],
    // which OpenRouter rejected with `provider.quantizations.0: Invalid option`.
    const entry = buildModelEntry("x", { quantizations: ["fp8 bf16 fp16"] });
    expect(entry.quantizations).toEqual(["fp8", "bf16", "fp16"]);
  });

  it("normalizes case, dedupes, and accepts a mix of comma and space separators", () => {
    const entry = buildModelEntry("x", { quantizations: ["FP8, bf16", "fp8 fp16"] });
    expect(entry.quantizations).toEqual(["fp8", "bf16", "fp16"]);
  });

  it("rejects an unknown quantization value", () => {
    expect(() => buildModelEntry("x", { quantizations: ["fp99"] })).toThrow(ModelOpError);
    expect(() => buildModelEntry("x", { quantizations: ["fp99"] })).toThrow(
      /Gecersiz quantization/,
    );
  });

  it("rejects a non-integer contextTokens (the `--context abc` -> NaN bug)", () => {
    expect(() => buildModelEntry("x", { contextTokens: Number.NaN })).toThrow(ModelOpError);
    expect(() => buildModelEntry("x", { contextTokens: -1 })).toThrow(ModelOpError);
    expect(() => buildModelEntry("x", { contextTokens: 1.5 })).toThrow(ModelOpError);
  });

  it("rejects a non-integer maxOutputTokens", () => {
    expect(() => buildModelEntry("x", { maxOutputTokens: Number.NaN })).toThrow(ModelOpError);
  });

  it("accepts valid positive integer context/maxOutputTokens", () => {
    const entry = buildModelEntry("x", { contextTokens: 128000, maxOutputTokens: 8000 });
    expect(entry).toMatchObject({ contextTokens: 128000, maxOutputTokens: 8000 });
  });

  it("rejects a negative or non-finite maxPrice", () => {
    expect(() => buildModelEntry("x", { maxPrice: { prompt: -1 } })).toThrow(ModelOpError);
    expect(() => buildModelEntry("x", { maxPrice: { completion: Number.NaN } })).toThrow(
      ModelOpError,
    );
  });
});

describe("mergeModelEntry", () => {
  const base = {
    id: "x",
    label: "X",
    reasoning: "high" as const,
    providerSort: "price" as const,
    quantizations: ["fp8"],
  };

  it("keeps fields the patch doesn't mention", () => {
    const merged = mergeModelEntry(base, {});
    expect(merged).toEqual(base);
  });

  it("overwrites a field the patch sets", () => {
    const merged = mergeModelEntry(base, { label: "Y" });
    expect(merged.label).toBe("Y");
    expect(merged.reasoning).toBe("high");
  });

  it("clears a field the patch sets to null", () => {
    const merged = mergeModelEntry(base, { reasoning: null, quantizations: null });
    expect(merged.reasoning).toBeUndefined();
    expect(merged.quantizations).toBeUndefined();
    expect(merged.label).toBe("X");
  });

  it("rejects an invalid reasoning value in a patch", () => {
    expect(() => mergeModelEntry(base, { reasoning: "ultra" })).toThrow(ModelOpError);
  });

  it("does not mutate the original entry", () => {
    const original = { ...base };
    mergeModelEntry(base, { label: "changed" });
    expect(base).toEqual(original);
  });

  it("clears autoRecovered when the user manually touches stream", () => {
    const autoRecovered = { ...base, stream: false, autoRecovered: true };

    expect(mergeModelEntry(autoRecovered, { stream: true }).autoRecovered).toBeUndefined();
    expect(mergeModelEntry(autoRecovered, { stream: false }).autoRecovered).toBeUndefined();
  });

  it("leaves autoRecovered alone when the patch doesn't mention stream", () => {
    const autoRecovered = { ...base, stream: false, autoRecovered: true };
    expect(mergeModelEntry(autoRecovered, { label: "Y" }).autoRecovered).toBe(true);
  });

  it("normalizes a space-separated quantizations patch the same way as buildModelEntry", () => {
    const merged = mergeModelEntry(base, { quantizations: ["fp8 bf16 fp16"] });
    expect(merged.quantizations).toEqual(["fp8", "bf16", "fp16"]);
  });

  it("rejects an invalid quantizations value in a patch", () => {
    expect(() => mergeModelEntry(base, { quantizations: ["fp99"] })).toThrow(ModelOpError);
  });

  it("rejects a NaN contextTokens patch", () => {
    expect(() => mergeModelEntry(base, { contextTokens: Number.NaN })).toThrow(ModelOpError);
  });
});

describe("validateModelEntry", () => {
  it("reports no problems for a valid entry", () => {
    expect(
      validateModelEntry({
        id: "x",
        quantizations: ["fp8", "bf16"],
        reasoning: "high",
        providerSort: "price",
        contextTokens: 128000,
        maxOutputTokens: 8000,
        maxPrice: { prompt: 1, completion: 2 },
      }),
    ).toEqual([]);
  });

  it("catches the historical bad-config shape: quantizations stored as one space-separated string", () => {
    const problems = validateModelEntry({ id: "x", quantizations: ["fp8 bf16 fp16"] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/quantizations gecersiz/);
  });

  it("catches an invalid reasoning/providerSort written directly into config.json", () => {
    const problems = validateModelEntry({
      id: "x",
      // Cast past the type system the way a hand-edited config.json would.
      reasoning: "ultra" as never,
      providerSort: "cheapest" as never,
    });
    expect(problems).toHaveLength(2);
  });

  it("catches non-integer contextTokens/maxOutputTokens", () => {
    const problems = validateModelEntry({
      id: "x",
      contextTokens: Number.NaN,
      maxOutputTokens: -5,
    });
    expect(problems).toHaveLength(2);
  });

  it("catches a negative maxPrice", () => {
    const problems = validateModelEntry({ id: "x", maxPrice: { prompt: -1 } });
    expect(problems).toEqual([expect.stringMatching(/maxPrice\.prompt gecersiz/)]);
  });
});

describe("updateModel", () => {
  it("replaces the stored entry", () => {
    const cfg = config([{ id: "openai/gpt-5", label: "GPT-5" }]);
    const updated = updateModel(cfg, "openai/gpt-5", { reasoning: "high" });

    expect(updated).toEqual({ id: "openai/gpt-5", label: "GPT-5", reasoning: "high" });
    expect(cfg.models[0]).toEqual(updated);
  });

  it("throws when the model isn't configured", () => {
    const cfg = config();
    expect(() => updateModel(cfg, "missing", {})).toThrow(ModelOpError);
  });

  it("removing a field via null survives being written back into config.models", () => {
    const cfg = config([{ id: "x", reasoning: "max" }]);
    updateModel(cfg, "x", { reasoning: null });
    expect(cfg.models[0]).toEqual({ id: "x" });
  });
});

describe("autofillFromCatalog", () => {
  it("fills unset fields from the catalog", async () => {
    const cfg = config([], { openrouterBaseUrl: catalogUrl });
    const result = await autofillFromCatalog(cfg, { id: "openai/gpt-5" });

    expect(result.status).toBe("filled");
    expect(result.entry).toEqual({
      id: "openai/gpt-5",
      label: "GPT-5",
      description: "Hizli bir model",
      contextTokens: 400000,
      maxOutputTokens: 64000,
    });
  });

  it("never overwrites a field the caller already set", async () => {
    const cfg = config([], { openrouterBaseUrl: catalogUrl });
    const result = await autofillFromCatalog(cfg, {
      id: "openai/gpt-5",
      label: "Benim etiketim",
      contextTokens: 1,
    });

    expect(result.entry.label).toBe("Benim etiketim");
    expect(result.entry.contextTokens).toBe(1);
    expect(result.entry.maxOutputTokens).toBe(64000);
  });

  it("reports not_found for an id the catalog doesn't have", async () => {
    const cfg = config([], { openrouterBaseUrl: catalogUrl });
    const result = await autofillFromCatalog(cfg, { id: "unknown/model" });
    expect(result.status).toBe("not_found");
    expect(result.entry).toEqual({ id: "unknown/model" });
  });

  it("reports catalog_error instead of throwing when the catalog is unreachable", async () => {
    const cfg = config([], { openrouterBaseUrl: "http://127.0.0.1:1" });
    const result = await autofillFromCatalog(cfg, { id: "x" });
    expect(result.status).toBe("catalog_error");
    expect(result.errorMessage).toBeTruthy();
  });
});

describe("addModel", () => {
  it("adds a model and autofills it from the catalog", async () => {
    const cfg = config([], { openrouterBaseUrl: catalogUrl });
    const result = await addModel(cfg, "openai/gpt-5");

    expect(result.status).toBe("filled");
    expect(cfg.models).toHaveLength(1);
    expect(cfg.models[0]).toMatchObject({ id: "openai/gpt-5", label: "GPT-5" });
  });

  it("throws when the model is already configured", async () => {
    const cfg = config([{ id: "openai/gpt-5" }], { openrouterBaseUrl: catalogUrl });
    await expect(addModel(cfg, "openai/gpt-5")).rejects.toThrow(ModelOpError);
  });

  it("rejects an invalid reasoning value before ever touching the catalog", async () => {
    const cfg = config([], { openrouterBaseUrl: catalogUrl });
    await expect(addModel(cfg, "openai/gpt-5", { reasoning: "ultra" })).rejects.toThrow(
      ModelOpError,
    );
    expect(cfg.models).toHaveLength(0);
  });
});

describe("removeModel", () => {
  it("removes an existing model and reports true", () => {
    const cfg = config([{ id: "a" }, { id: "b" }]);
    expect(removeModel(cfg, "a")).toBe(true);
    expect(cfg.models).toEqual([{ id: "b" }]);
  });

  it("reports false for a model that isn't configured", () => {
    const cfg = config([{ id: "a" }]);
    expect(removeModel(cfg, "missing")).toBe(false);
    expect(cfg.models).toEqual([{ id: "a" }]);
  });
});

describe("autofillFromCatalog wasFree behavior", () => {
  it("sets wasFree=true when catalog has promptPrice=0 and completionPrice=0", async () => {
    const freeCatalog = createServer((req, res) => {
      if (req.url === "/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            data: [
              {
                id: "free/model",
                name: "Free Model",
                context_length: 8000,
                top_provider: { max_completion_tokens: 4000 },
                pricing: { prompt: "0", completion: "0" },
              },
            ],
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => freeCatalog.listen(0, "127.0.0.1", resolve));
    const freeUrl = `http://127.0.0.1:${(freeCatalog.address() as AddressInfo).port}`;

    const cfg = config([], { openrouterBaseUrl: freeUrl });
    const result = await autofillFromCatalog(cfg, { id: "free/model" });

    expect(result.status).toBe("filled");
    expect(result.entry.wasFree).toBe(true);
    await new Promise<void>((resolve) => freeCatalog.close(() => resolve()));
  });

  it("sets wasFree=false when catalog has promptPrice>0", async () => {
    const paidCatalog = createServer((req, res) => {
      if (req.url === "/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            data: [
              {
                id: "paid/model",
                name: "Paid Model",
                context_length: 8000,
                top_provider: { max_completion_tokens: 4000 },
                pricing: { prompt: "0.000001", completion: "0.000002" },
              },
            ],
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => paidCatalog.listen(0, "127.0.0.1", resolve));
    const paidUrl = `http://127.0.0.1:${(paidCatalog.address() as AddressInfo).port}`;

    const cfg = config([], { openrouterBaseUrl: paidUrl });
    const result = await autofillFromCatalog(cfg, { id: "paid/model" });

    expect(result.status).toBe("filled");
    expect(result.entry.wasFree).toBe(false);
    await new Promise<void>((resolve) => paidCatalog.close(() => resolve()));
  });
});

describe("checkFreeTierDrift", () => {
  let catalogServer: Server;
  let catalogUrl: string;

  beforeAll(async () => {
    catalogServer = createServer((req, res) => {
      if (req.url === "/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            data: [
              {
                id: "free/model",
                name: "Free Model",
                context_length: 8000,
                top_provider: { max_completion_tokens: 4000 },
                pricing: { prompt: "0.000001", completion: "0.000002" }, // became paid
              },
              {
                id: "still-free/model",
                name: "Still Free",
                context_length: 8000,
                top_provider: { max_completion_tokens: 4000 },
                pricing: { prompt: "0", completion: "0" }, // still free
              },
              {
                id: "unknown-price/model",
                name: "Unknown Price",
                context_length: 8000,
                top_provider: { max_completion_tokens: 4000 },
                // no pricing field = unknown
              },
              {
                id: "was-paid/model",
                name: "Was Paid",
                context_length: 8000,
                top_provider: { max_completion_tokens: 4000 },
                pricing: { prompt: "0.000001", completion: "0.000002" },
              },
            ],
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => catalogServer.listen(0, "127.0.0.1", resolve));
    catalogUrl = `http://127.0.0.1:${(catalogServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => catalogServer.close(() => resolve()));
  });

  it("detects drift for wasFree:true model with no priceDrift when catalog shows paid", async () => {
    const cfg = config(
      [
        { id: "free/model", wasFree: true },
        { id: "still-free/model", wasFree: true },
      ],
      { openrouterBaseUrl: catalogUrl },
    );

    const catalog = await (await import("../src/openrouterCatalog.js")).fetchCatalog(cfg);
    const driftResult = checkFreeTierDrift(cfg, catalog);

    // Only free/model should be detected (became paid), still-free/model still free
    expect(driftResult).toHaveLength(1);
    expect(driftResult[0]?.id).toBe("free/model");
    expect(driftResult[0]?.promptPrice).toBeGreaterThan(0);
    expect(driftResult[0]?.completionPrice).toBeGreaterThan(0);
    expect(cfg.models.find((m) => m.id === "free/model")?.priceDrift).toBeDefined();
  });

  it("returns empty array on second call for same model (priceDrift already set)", async () => {
    const cfg = config(
      [
        { id: "free/model", wasFree: true },
      ],
      { openrouterBaseUrl: catalogUrl },
    );

    const catalog = await (await import("../src/openrouterCatalog.js")).fetchCatalog(cfg);
    checkFreeTierDrift(cfg, catalog);
    const secondCall = checkFreeTierDrift(cfg, catalog);

    expect(secondCall).toEqual([]);
  });

  it("does not touch wasFree:false model", async () => {
    const cfg = config(
      [
        { id: "was-paid/model", wasFree: false },
      ],
      { openrouterBaseUrl: catalogUrl },
    );

    const catalog = await (await import("../src/openrouterCatalog.js")).fetchCatalog(cfg);
    const drift = checkFreeTierDrift(cfg, catalog);

    expect(drift).toEqual([]);
    expect(cfg.models.find((m) => m.id === "was-paid/model")?.priceDrift).toBeUndefined();
  });

  it("does not touch model with wasFree:true but catalog still shows free", async () => {
    const cfg = config(
      [
        { id: "still-free/model", wasFree: true },
      ],
      { openrouterBaseUrl: catalogUrl },
    );

    const catalog = await (await import("../src/openrouterCatalog.js")).fetchCatalog(cfg);
    const drift = checkFreeTierDrift(cfg, catalog);

    expect(drift).toEqual([]);
    expect(cfg.models.find((m) => m.id === "still-free/model")?.priceDrift).toBeUndefined();
  });

  it("does not touch model with wasFree:true but catalog has unknown price (null)", async () => {
    const cfg = config(
      [
        { id: "unknown-price/model", wasFree: true },
      ],
      { openrouterBaseUrl: catalogUrl },
    );

    const catalog = await (await import("../src/openrouterCatalog.js")).fetchCatalog(cfg);
    const drift = checkFreeTierDrift(cfg, catalog);

    expect(drift).toEqual([]);
    expect(cfg.models.find((m) => m.id === "unknown-price/model")?.priceDrift).toBeUndefined();
  });
});

describe("mergeModelEntry with priceDrift and wasFree", () => {
  const base = {
    id: "x",
    label: "X",
    wasFree: true,
    priceDrift: { detectedAt: 123, promptPrice: 1, completionPrice: 2 },
  };

  it("clears priceDrift when patch has priceDrift: null", () => {
    const merged = mergeModelEntry(base, { priceDrift: null } as any);
    expect(merged.priceDrift).toBeUndefined();
    expect(merged.wasFree).toBe(true);
  });

  it("clears wasFree when patch has wasFree: null", () => {
    const merged = mergeModelEntry(base, { wasFree: null } as any);
    expect(merged.wasFree).toBeUndefined();
    expect(merged.priceDrift).toBeDefined();
  });
});
