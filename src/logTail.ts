import { existsSync, openSync, closeSync, fstatSync, readSync } from "node:fs";

/** How far back to read before giving up on finding `maxLines` newlines. */
const MAX_TAIL_BYTES = 512 * 1024;

/**
 * Returns the last `maxLines` lines of a file without loading the whole
 * thing into memory — proxy.log can grow large over a long-running session.
 * Reads from the end in one chunk (bounded by MAX_TAIL_BYTES) rather than
 * streaming backwards line by line, which is simpler and fast enough for a
 * log a person is glancing at, not parsing.
 */
export function tailLines(path: string, maxLines: number): string[] {
  if (!existsSync(path)) return [];

  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const readSize = Math.min(size, MAX_TAIL_BYTES);
    const start = size - readSize;
    const buffer = Buffer.alloc(readSize);
    readSync(fd, buffer, 0, readSize, start);

    const text = buffer.toString("utf8");
    const lines = text.split("\n").filter((line) => line.length > 0);
    // The read may start mid-line; drop a partial first line unless the tail
    // covers the whole file, in which case there is no partial line to drop.
    const usable = start > 0 ? lines.slice(1) : lines;
    return usable.slice(-maxLines);
  } finally {
    closeSync(fd);
  }
}
