import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderAgent } from "../src/agentTemplate.js";
import {
  AgentOpError,
  deleteAgent,
  listAgents,
  parseAgentFrontmatter,
} from "../src/agentDiscovery.js";
import { DEFAULT_CONFIG, type Config } from "../src/config.js";

let projectDir: string;
let userDir: string;
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
const originalCwd = process.cwd();

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "cor-agents-project-"));
  userDir = mkdtempSync(join(tmpdir(), "cor-agents-user-"));
  process.chdir(projectDir);
  process.env.CLAUDE_CONFIG_DIR = userDir;
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(userDir, { recursive: true, force: true });
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
});

function config(models: Config["models"] = []): Config {
  return { ...DEFAULT_CONFIG, models };
}

describe("parseAgentFrontmatter", () => {
  it("parses renderAgent()'s own output", () => {
    const text = renderAgent({ name: "kodcu", modelId: "openai/gpt-5", scope: "project" });
    const fields = parseAgentFrontmatter(text);

    expect(fields.name).toBe("kodcu");
    expect(fields.model).toBe("openai/gpt-5");
    expect(fields.tools).toBe("Read, Edit, Write");
    expect(fields.permissionMode).toBe("acceptEdits");
  });

  it("skips a YAML list-form tools field instead of misparsing it", () => {
    const text = `---
name: hand-written
model: openai/gpt-5
tools:
  - Read
  - Edit
---
gövde
`;
    const fields = parseAgentFrontmatter(text);
    expect(fields.name).toBe("hand-written");
    expect(fields.model).toBe("openai/gpt-5");
    expect(fields.tools).toBeUndefined();
  });

  it("strips matching quotes and keeps a colon inside a quoted value", () => {
    const text = `---
name: x
description: "Reads files: carefully"
---
`;
    const fields = parseAgentFrontmatter(text);
    expect(fields.description).toBe("Reads files: carefully");
  });

  it("returns an empty object for a file with no frontmatter", () => {
    expect(parseAgentFrontmatter("just some text\nno fences here\n")).toEqual({});
  });

  it("tolerates CRLF line endings and a leading BOM", () => {
    const text = "﻿---\r\nname: x\r\nmodel: y\r\n---\r\nbody\r\n";
    expect(parseAgentFrontmatter(text)).toEqual({ name: "x", model: "y" });
  });
});

describe("listAgents", () => {
  it("returns an empty list when neither directory exists", () => {
    expect(listAgents(config())).toEqual([]);
  });

  it("finds a project agent written by renderAgent and flags it as configured", () => {
    mkdirSync(join(projectDir, ".claude", "agents"), { recursive: true });
    writeFileSync(
      join(projectDir, ".claude", "agents", "kodcu.md"),
      renderAgent({ name: "kodcu", modelId: "openai/gpt-5", scope: "project" }),
    );

    const agents = listAgents(config([{ id: "openai/gpt-5" }]));

    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      name: "kodcu",
      scope: "project",
      model: "openai/gpt-5",
      configured: true,
      claudeModel: false,
    });
  });

  it("flags an agent pinned to a Claude model instead of a configured OpenRouter one", () => {
    mkdirSync(join(projectDir, ".claude", "agents"), { recursive: true });
    writeFileSync(
      join(projectDir, ".claude", "agents", "reviewer.md"),
      "---\nname: reviewer\nmodel: claude-sonnet-5\n---\nbody\n",
    );

    const agents = listAgents(config());
    expect(agents[0]).toMatchObject({ model: "claude-sonnet-5", configured: false, claudeModel: true });
  });

  it("treats a missing model field as inherit / a Claude model", () => {
    mkdirSync(join(projectDir, ".claude", "agents"), { recursive: true });
    writeFileSync(join(projectDir, ".claude", "agents", "plain.md"), "---\nname: plain\n---\nbody\n");

    const agents = listAgents(config());
    expect(agents[0]).toMatchObject({ configured: false, claudeModel: true });
  });

  it("collects agents from both project and user scope", () => {
    mkdirSync(join(projectDir, ".claude", "agents"), { recursive: true });
    mkdirSync(join(userDir, "agents"), { recursive: true });
    writeFileSync(
      join(projectDir, ".claude", "agents", "a.md"),
      renderAgent({ name: "a", modelId: "openai/gpt-5", scope: "project" }),
    );
    writeFileSync(
      join(userDir, "agents", "b.md"),
      renderAgent({ name: "b", modelId: "qwen/qwen3-max", scope: "user" }),
    );

    const agents = listAgents(config());
    expect(agents.map((a) => [a.name, a.scope]).sort()).toEqual([
      ["a", "project"],
      ["b", "user"],
    ]);
  });

  it("ignores non-.md files in the agents directory", () => {
    mkdirSync(join(projectDir, ".claude", "agents"), { recursive: true });
    writeFileSync(join(projectDir, ".claude", "agents", "notes.txt"), "not an agent");
    expect(listAgents(config())).toEqual([]);
  });
});

describe("deleteAgent", () => {
  it("deletes an agent file inside the project agents directory", () => {
    mkdirSync(join(projectDir, ".claude", "agents"), { recursive: true });
    const file = join(projectDir, ".claude", "agents", "kodcu.md");
    writeFileSync(file, renderAgent({ name: "kodcu", modelId: "x", scope: "project" }));

    deleteAgent(file);
    expect(existsSync(file)).toBe(false);
  });

  it("deletes an agent file inside the user agents directory", () => {
    mkdirSync(join(userDir, "agents"), { recursive: true });
    const file = join(userDir, "agents", "kodcu.md");
    writeFileSync(file, renderAgent({ name: "kodcu", modelId: "x", scope: "user" }));

    deleteAgent(file);
    expect(existsSync(file)).toBe(false);
  });

  it("refuses a path outside the known agents directories", () => {
    const outside = join(projectDir, "not-an-agents-dir.md");
    writeFileSync(outside, "junk");

    expect(() => deleteAgent(outside)).toThrow(AgentOpError);
    expect(existsSync(outside)).toBe(true);
  });

  it("refuses a path-traversal attempt through an agents directory", () => {
    mkdirSync(join(projectDir, ".claude", "agents"), { recursive: true });
    const secret = join(projectDir, "secret.md");
    writeFileSync(secret, "do not delete me");

    const traversal = join(projectDir, ".claude", "agents", "..", "..", "secret.md");
    expect(() => deleteAgent(traversal)).toThrow(AgentOpError);
    expect(existsSync(secret)).toBe(true);
  });

  it("refuses a non-.md file even inside an agents directory", () => {
    mkdirSync(join(projectDir, ".claude", "agents"), { recursive: true });
    const file = join(projectDir, ".claude", "agents", "notes.txt");
    writeFileSync(file, "junk");

    expect(() => deleteAgent(file)).toThrow(AgentOpError);
    expect(existsSync(file)).toBe(true);
  });

  it("reports a clear error for a file that doesn't exist", () => {
    mkdirSync(join(projectDir, ".claude", "agents"), { recursive: true });
    const file = join(projectDir, ".claude", "agents", "missing.md");
    expect(() => deleteAgent(file)).toThrow(AgentOpError);
  });
});
