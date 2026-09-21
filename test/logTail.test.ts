import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tailLines } from "../src/logTail.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cor-logtail-"));
  file = join(dir, "proxy.log");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("tailLines", () => {
  it("returns an empty array when the file doesn't exist", () => {
    expect(tailLines(file, 10)).toEqual([]);
  });

  it("returns all lines when there are fewer than the limit", () => {
    writeFileSync(file, "a\nb\nc\n");
    expect(tailLines(file, 10)).toEqual(["a", "b", "c"]);
  });

  it("returns only the last N lines", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i}`);
    writeFileSync(file, `${lines.join("\n")}\n`);
    expect(tailLines(file, 5)).toEqual(["line-15", "line-16", "line-17", "line-18", "line-19"]);
  });

  it("handles a file with no trailing newline", () => {
    writeFileSync(file, "a\nb\nc");
    expect(tailLines(file, 10)).toEqual(["a", "b", "c"]);
  });

  it("drops a partial first line when the tail doesn't start at byte 0", () => {
    // Force a small read window so the tail genuinely starts mid-file.
    const lines = Array.from({ length: 2000 }, (_, i) => `line-${i}-padding-to-make-this-longer`);
    writeFileSync(file, `${lines.join("\n")}\n`);

    const tail = tailLines(file, 5);
    expect(tail).toHaveLength(5);
    expect(tail[4]).toBe("line-1999-padding-to-make-this-longer");
    // No entry should be a truncated fragment of a line (i.e. missing its
    // "line-" prefix), which is what a mis-handled partial read would produce.
    expect(tail.every((line) => line.startsWith("line-"))).toBe(true);
  });
});
