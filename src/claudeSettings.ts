import { homedir } from "node:os";
import { join } from "node:path";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { ModelEntry } from "./config.js";

export interface ModelPickerOption {
  model: string;
  label?: string;
  description?: string;
  behavesAs?: string;
}

export interface ModelPicker {
  options: ModelPickerOption[];
  replaceBuiltInOptions?: boolean;
}

/**
 * modelPicker is read only from managed, --settings and user scope, so the
 * lineup has to live in the user settings file rather than a project one.
 */
export function claudeSettingsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(dir, "settings.json");
}

export function backupPath(): string {
  return `${claudeSettingsPath()}.cor-bak`;
}

export function readClaudeSettings(): Record<string, unknown> {
  const path = claudeSettingsPath();
  if (!existsSync(path)) return {};

  const raw = readFileSync(path, "utf8").trim();
  if (raw === "") return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${path} gecerli JSON degil, dokunulmadi: ${(err as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} bir JSON nesnesi olmali, dokunulmadi.`);
  }
  return parsed as Record<string, unknown>;
}

export function buildModelPicker(models: ModelEntry[]): ModelPicker {
  return {
    options: models.map((model) => ({
      model: model.id,
      label: model.label ?? model.id,
      description: model.description ?? "OpenRouter uzerinden",
      ...(model.behavesAs ? { behavesAs: model.behavesAs } : {}),
    })),
    // false keeps the built-in Claude lineup and appends these rows below it.
    replaceBuiltInOptions: false,
  };
}

/** Writes only the modelPicker key; every other setting is preserved. */
export function syncModelPicker(models: ModelEntry[]): { path: string; removed: boolean } {
  const path = claudeSettingsPath();
  const settings = readClaudeSettings();

  if (existsSync(path)) copyFileSync(path, backupPath());

  let removed = false;
  if (models.length === 0) {
    delete settings.modelPicker;
    removed = true;
  } else {
    settings.modelPicker = buildModelPicker(models);
  }

  writeSettings(path, settings);
  return { path, removed };
}

/** Restores the file saved before the last sync. */
export function revertModelPicker(): { path: string; restored: boolean } {
  const path = claudeSettingsPath();
  const backup = backupPath();
  if (!existsSync(backup)) {
    // Nothing to restore from: just drop the key we own.
    const settings = readClaudeSettings();
    if (!("modelPicker" in settings)) return { path, restored: false };
    delete settings.modelPicker;
    writeSettings(path, settings);
    return { path, restored: true };
  }

  copyFileSync(backup, path);
  return { path, restored: true };
}

function writeSettings(path: string, settings: Record<string, unknown>): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(tmp, path);
}
