import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  backupPath,
  buildModelPicker,
  claudeSettingsPath,
  readClaudeSettings,
  revertModelPicker,
  syncModelPicker,
} from "../src/claudeSettings.js";

let dir: string;
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cor-settings-"));
  process.env.CLAUDE_CONFIG_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
});

function writeSettings(value: unknown): void {
  writeFileSync(claudeSettingsPath(), JSON.stringify(value, null, 2));
}

function readSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(claudeSettingsPath(), "utf8")) as Record<string, unknown>;
}

describe("buildModelPicker", () => {
  it("carries behavesAs onto the picker row when it is set", () => {
    const picker = buildModelPicker([{ id: "x/y", behavesAs: "claude-sonnet-5" }]);
    expect(picker.options[0]?.behavesAs).toBe("claude-sonnet-5");
    expect(buildModelPicker([{ id: "x/y" }]).options[0]).not.toHaveProperty("behavesAs");
  });

  it("keeps the built-in lineup and appends the configured models", () => {
    const picker = buildModelPicker([
      { id: "openai/gpt-5", label: "GPT-5", description: "hizli" },
      { id: "qwen/qwen3-max" },
    ]);

    expect(picker.replaceBuiltInOptions).toBe(false);
    expect(picker.options).toEqual([
      { model: "openai/gpt-5", label: "GPT-5", description: "hizli" },
      { model: "qwen/qwen3-max", label: "qwen/qwen3-max", description: "OpenRouter uzerinden" },
    ]);
  });
});

describe("syncModelPicker", () => {
  it("leaves every other setting untouched", () => {
    writeSettings({ model: "sonnet", permissions: { allow: ["Bash(ls:*)"] } });

    syncModelPicker([{ id: "openai/gpt-5", label: "GPT-5" }]);

    const settings = readSettings();
    expect(settings.model).toBe("sonnet");
    expect(settings.permissions).toEqual({ allow: ["Bash(ls:*)"] });
    expect((settings.modelPicker as { options: unknown[] }).options).toHaveLength(1);
  });

  it("keeps the original backup across a second sync", () => {
    writeSettings({ model: "opus", theme: "dark" });
    syncModelPicker([{ id: "openai/gpt-5" }]);
    // A later sync must not overwrite the backup with a cor-written file —
    // the backup has to stay "before cor ever touched this" for revert to work.
    syncModelPicker([{ id: "openai/gpt-5" }, { id: "qwen/qwen3-max" }]);

    revertModelPicker();
    expect(readSettings()).toEqual({ model: "opus", theme: "dark" });
  });

  it("creates the file when there are no settings yet", () => {
    syncModelPicker([{ id: "openai/gpt-5" }]);
    expect(readSettings().modelPicker).toBeDefined();
  });

  it("removes the key when the model list is empty", () => {
    writeSettings({ model: "sonnet", modelPicker: { options: [{ model: "x" }] } });

    const result = syncModelPicker([]);

    expect(result.removed).toBe(true);
    expect(readSettings().modelPicker).toBeUndefined();
    expect(readSettings().model).toBe("sonnet");
  });

  it("refuses to touch a settings file that is not valid JSON", () => {
    writeFileSync(claudeSettingsPath(), "{ bozuk json");
    expect(() => syncModelPicker([{ id: "openai/gpt-5" }])).toThrow(/gecerli JSON degil/);
    expect(readFileSync(claudeSettingsPath(), "utf8")).toBe("{ bozuk json");
  });

  it("treats an empty settings file as empty settings", () => {
    writeFileSync(claudeSettingsPath(), "   ");
    expect(readClaudeSettings()).toEqual({});
  });
});

describe("revertModelPicker", () => {
  it("restores the file saved before the sync", () => {
    writeSettings({ model: "opus", theme: "dark" });
    syncModelPicker([{ id: "openai/gpt-5" }]);
    expect(readSettings().modelPicker).toBeDefined();

    const result = revertModelPicker();

    expect(result.restored).toBe(true);
    expect(readSettings()).toEqual({ model: "opus", theme: "dark" });
    expect(existsSync(backupPath())).toBe(true);
  });

  it("drops the key when there is no backup to restore", () => {
    writeSettings({ model: "opus", modelPicker: { options: [] } });

    expect(revertModelPicker().restored).toBe(true);
    expect(readSettings()).toEqual({ model: "opus" });
  });

  it("reports nothing to do on a file it never touched", () => {
    writeSettings({ model: "opus" });
    expect(revertModelPicker().restored).toBe(false);
  });
});
