import { describe, expect, it } from "vitest";
import { routeFor } from "../src/router.js";
import { DEFAULT_CONFIG, type Config } from "../src/config.js";

const config: Config = {
  ...DEFAULT_CONFIG,
  models: [{ id: "openai/gpt-5" }, { id: "qwen/qwen3-max" }],
};

describe("routeFor", () => {
  it("sends configured models to OpenRouter", () => {
    expect(routeFor(config, "openai/gpt-5")).toEqual({
      target: "openrouter",
      entry: { id: "openai/gpt-5" },
    });
  });

  it("strips the [1m] suffix Claude Code appends", () => {
    expect(routeFor(config, "qwen/qwen3-max[1m]").target).toBe("openrouter");
  });

  it("passes Claude ids and aliases through to Anthropic", () => {
    for (const model of ["claude-opus-5", "sonnet", "haiku", "opusplan", "claude-haiku-4-5"]) {
      expect(routeFor(config, model)).toEqual({ target: "anthropic" });
    }
  });

  it("passes through an unknown or missing model", () => {
    expect(routeFor(config, "openai/gpt-4o").target).toBe("anthropic");
    expect(routeFor(config, undefined).target).toBe("anthropic");
  });
});
