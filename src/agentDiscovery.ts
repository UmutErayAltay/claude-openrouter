import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
