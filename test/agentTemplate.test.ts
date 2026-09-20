import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentPath, renderAgent, writeAgent } from "../src/agentTemplate.js";

describe("renderAgent", () => {
  const agent = renderAgent({
    name: "dosya-kodcu",
    modelId: "qwen/qwen3-coder-30b-a3b-instruct",
    scope: "project",
    label: "Qwen3 Coder 30B",
  });

  it("pins the subagent to the OpenRouter model", () => {
    expect(agent).toContain("model: qwen/qwen3-coder-30b-a3b-instruct");
    expect(agent).toContain("name: dosya-kodcu");
  });

  it("keeps the tool list short, which is what keeps these models steady", () => {
    expect(agent).toContain("tools: Read, Edit, Write");
    // No Bash, Glob or Grep: the agent can't wander off its one file.
    expect(agent).not.toMatch(/tools:.*Bash/);
    expect(agent).not.toMatch(/tools:.*Glob/);
  });

  it("falls back to the model id when there is no label", () => {
    const bare = renderAgent({ name: "x", modelId: "openai/gpt-5", scope: "project" });
    expect(bare).toContain("Sen openai/gpt-5 uzerinde calisan");
  });
});

describe("writeAgent", () => {
  let dir: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cor-agent-"));
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes into the project's .claude/agents", () => {
    const { path, overwritten } = writeAgent({
      name: "dosya-kodcu",
      modelId: "openai/gpt-5",
      scope: "project",
    });

    expect(overwritten).toBe(false);
    expect(path).toBe(agentPath("dosya-kodcu", "project"));
    expect(readFileSync(path, "utf8")).toContain("model: openai/gpt-5");
  });

  it("reports when it replaced an existing agent", () => {
    writeAgent({ name: "dosya-kodcu", modelId: "openai/gpt-5", scope: "project" });
    const second = writeAgent({ name: "dosya-kodcu", modelId: "openai/gpt-5", scope: "project" });

    expect(second.overwritten).toBe(true);
  });
});
