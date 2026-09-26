import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { agentsDir } from "./agentTemplate.js";
import { findModel, type Config } from "./config.js";

export type AgentScope = "project" | "user";

export interface AgentSummary {
  name: string;
  file: string;
  scope: AgentScope;
  model?: string;
  tools?: string[];
  permissionMode?: string;
  description?: string;
  /** The `model` field matches an id in config.models. */
  configured: boolean;
  /** The `model` field is missing, "inherit", or names a Claude model/alias. */
  claudeModel: boolean;
}

const CLAUDE_MODEL_PATTERN = /claude|anthropic|opus|sonnet|haiku|fable|inherit/i;

/**
 * Parses the `key: value` frontmatter block our own `renderAgent()` writes.
 * Not a YAML parser: it degrades on the shapes a hand-authored file might use
 * (a `tools:` YAML list, a multi-line `description:` block) rather than
 * crashing on them — those lines are simply skipped, since this is a display
 * feature, not a config loader.
 */
export function parseAgentFrontmatter(text: string): Record<string, string> {
  const withoutBom = text.replace(/^﻿/, "");
  const lines = withoutBom.split(/\r?\n/);

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      start = i;
      break;
    }
    if (lines[i]?.trim() !== "") break; // Only leading blank lines are tolerated.
  }
  if (start === -1) return {};

  const fields: Record<string, string> = {};
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "---") break;

    // Indented continuation lines and "- item" list entries aren't key:value
    // pairs; skip rather than misparse them.
    if (/^\s/.test(line) || line.trim().startsWith("-")) continue;

    const colon = line.indexOf(":");
    if (colon === -1) continue;

    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    // An empty value usually means a YAML block/list follows on later,
    // indented lines (e.g. `tools:` then `  - Read`) rather than a genuine
    // empty string — leave the field unset so the list isn't mistaken for it.
    if (key && value !== "") fields[key] = value;
  }

  return fields;
}

function readAgentFile(path: string, name: string, scope: AgentScope): AgentSummary | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }

  const fields = parseAgentFrontmatter(text);
  const model = fields.model;

  return {
    name: fields.name || name,
    file: path,
    scope,
    model,
    tools: fields.tools
      ? fields.tools.split(",").map((tool) => tool.trim()).filter(Boolean)
      : undefined,
    permissionMode: fields.permissionMode,
    description: fields.description,
    configured: false,
    claudeModel: !model || CLAUDE_MODEL_PATTERN.test(model),
  };
}

function listScope(scope: AgentScope): AgentSummary[] {
  const dir = agentsDir(scope);
  if (!existsSync(dir)) return [];

  const summaries: AgentSummary[] = [];
  for (const filename of readdirSync(dir)) {
    if (!filename.endsWith(".md")) continue;
    const summary = readAgentFile(join(dir, filename), filename.replace(/\.md$/, ""), scope);
    if (summary) summaries.push(summary);
  }
  return summaries;
}

/** Lists every subagent Claude Code would load, flagging ones we manage. */
export function listAgents(config: Config): AgentSummary[] {
  const agents = [...listScope("project"), ...listScope("user")];
  for (const agent of agents) {
    agent.configured = Boolean(agent.model && findModel(config, agent.model));
  }
  return agents;
}

export class AgentOpError extends Error {}

/**
 * The dashboard's HTTP API hands us a path the client chose, so every
 * file-touching operation re-derives the allowed set (the two known agents
 * directories) rather than trusting the input: without this, a crafted path
 * could reach any file the process can touch.
 */
function resolveAgentFile(file: string): string {
  const allowedDirs = [agentsDir("project"), agentsDir("user")];
  const resolved = resolve(file);

  const withinAllowedDir = allowedDirs.some((dir) => {
    const dirWithSep = dir.endsWith(sep) ? dir : dir + sep;
    return resolved.startsWith(dirWithSep);
  });
  if (!withinAllowedDir || !resolved.endsWith(".md")) {
    throw new AgentOpError(`Bu dosya duzenlenemez: ${file}`);
  }
  return resolved;
}

function requireExistingAgentFile(file: string): string {
  const resolved = resolveAgentFile(file);
  if (!existsSync(resolved)) {
    throw new AgentOpError(`Dosya bulunamadi: ${file}`);
  }
  return resolved;
}

/** Reads an agent's frontmatter and body, for the dashboard's edit form. */
export function readAgent(file: string): { frontmatter: Record<string, string>; body: string; file: string } {
  const resolved = requireExistingAgentFile(file);
  const text = readFileSync(resolved, "utf8");
  return { frontmatter: parseAgentFrontmatter(text), body: stripFrontmatter(text), file: resolved };
}

/** Everything before the closing `---` line is frontmatter; the rest is the prompt. */
function stripFrontmatter(text: string): string {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const closing = lines.indexOf("---", 1);
  if (closing === -1) return text;
  return lines.slice(closing + 1).join("\n").replace(/^\n+/, "");
}

function renderFrontmatter(fields: Record<string, string>): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join("\n")}\n---`;
}

export interface AgentPatch {
  model?: string;
  tools?: string[];
  description?: string;
  body?: string;
}

/**
 * Rewrites an agent's frontmatter, keeping every key we don't manage — a
 * hand-authored `permissionMode` or `maxTurns` survives an edit from the
 * dashboard. Written through a temp file so a crash mid-write can't leave a
 * half-written agent that Claude Code would fail to load.
 */
export function updateAgent(file: string, patch: AgentPatch): void {
  const resolved = requireExistingAgentFile(file);
  const { frontmatter, body } = readAgent(resolved);

  const fields: Record<string, string> = { ...frontmatter };
  if (patch.model !== undefined) fields.model = patch.model;
  if (patch.description !== undefined) fields.description = patch.description;
  // Claude Code's own format: a comma-separated list on one line.
  if (patch.tools !== undefined) fields.tools = patch.tools.map((tool) => tool.trim()).filter(Boolean).join(", ");

  const nextBody = patch.body ?? body;
  const text = `${renderFrontmatter(fields)}\n\n${nextBody.replace(/\s+$/, "")}\n`;

  const tmp = `${resolved}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, resolved);
}

/**
 * Deletes an agent file. This is reachable from the dashboard's HTTP API
 * with a path the client supplies, so it re-derives an allowed set of paths
 * (the two known agents directories) rather than trusting the input:
 * without this, a crafted path could delete any file the process can reach.
 */
export function deleteAgent(file: string): void {
  unlinkSync(requireExistingAgentFile(file));
}
