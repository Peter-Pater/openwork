import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  addArtifact,
  artifactFilePath,
  hasUrl,
  isSafeArtifactId,
  isSafeSessionId,
  MAX_ARTIFACTS_PER_SESSION,
  readIndex,
  sessionArtifactsDir,
  sniffImage,
} from "./session-artifact-store.js";

let dataDir: string;
let previousDataDir: string | undefined;

beforeEach(() => {
  previousDataDir = process.env.OPENWORK_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "openwork-artifacts-"));
  process.env.OPENWORK_DATA_DIR = dataDir;
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.OPENWORK_DATA_DIR;
  else process.env.OPENWORK_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

// A minimal-but-real PNG signature followed by junk -- enough for the sniffer,
// which reads magic bytes, not structure.
function fakePng(seed = 0): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([seed, 1, 2, 3, 4, 5, 6, 7]),
  ]);
}

describe("artifacts: sniffImage", () => {
  test("recognizes png/jpeg/gif/webp/avif by magic bytes", () => {
    expect(sniffImage(fakePng())?.mime).toBe("image/png");
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))?.mime).toBe("image/jpeg");
    expect(sniffImage(Buffer.from("GIF89a??????"))?.mime).toBe("image/gif");
    expect(sniffImage(Buffer.from("RIFF????WEBP"))?.mime).toBe("image/webp");
    expect(sniffImage(Buffer.from("????ftypavif"))?.mime).toBe("image/avif");
  });

  test("routes HTML and SVG as non-images regardless of any header claim", () => {
    // The routing invariant: a bare image must never reach the page renderer,
    // and markup -- including SVG, which browsers treat as a document -- must
    // never be filed as an image.
    expect(sniffImage(Buffer.from("<!doctype html><html>...</html>"))).toBeNull();
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeNull();
    expect(sniffImage(Buffer.from(""))).toBeNull();
  });
});

describe("artifacts: id validation", () => {
  test("session ids are a closed alphabet; artifact ids are sha256 hex", () => {
    expect(isSafeSessionId("ses_abc123")).toBe(true);
    expect(isSafeSessionId("../escape")).toBe(false);
    expect(isSafeSessionId("a/b")).toBe(false);
    expect(isSafeSessionId("")).toBe(false);
    expect(isSafeArtifactId("a".repeat(64))).toBe(true);
    expect(isSafeArtifactId("A".repeat(64))).toBe(false); // hex is lowercase
    expect(isSafeArtifactId("a".repeat(63))).toBe(false);
  });
});

describe("artifacts: addArtifact / readIndex", () => {
  const base = { url: "https://example.com/a.png", finalUrl: "https://cdn.example.com/a.png", title: null, width: 10, height: 10 };

  test("stores bytes under the sha, appends the index entry", () => {
    const entry = addArtifact("ses_1", { kind: "image", bytes: fakePng(), ...base });
    expect(entry).not.toBeNull();
    expect(entry!.id).toMatch(/^[0-9a-f]{64}$/);
    expect(entry!.file).toBe(`${entry!.id}.png`);
    expect(existsSync(join(sessionArtifactsDir("ses_1"), entry!.file))).toBe(true);
    expect(readIndex("ses_1")).toHaveLength(1);
    expect(readFileSync(artifactFilePath("ses_1", entry!.id)!)[0]).toBe(0x89);
  });

  test("byte-identical content dedupes even from a different URL", () => {
    addArtifact("ses_1", { kind: "image", bytes: fakePng(7), ...base });
    const dup = addArtifact("ses_1", { kind: "image", bytes: fakePng(7), ...base, url: "https://other.example/same.png" });
    expect(dup).toBeNull();
    expect(readIndex("ses_1")).toHaveLength(1);
  });

  test("an 'image' whose bytes are not an image is refused (server-side re-verification)", () => {
    const entry = addArtifact("ses_1", { kind: "image", bytes: Buffer.from("<html>login page</html>"), ...base });
    expect(entry).toBeNull();
    expect(readIndex("ses_1")).toHaveLength(0);
  });

  test("hasUrl matches on requested and final URL", () => {
    addArtifact("ses_1", { kind: "image", bytes: fakePng(1), ...base });
    expect(hasUrl("ses_1", "https://example.com/a.png")).toBe(true);
    expect(hasUrl("ses_1", "https://cdn.example.com/a.png")).toBe(true);
    expect(hasUrl("ses_1", "https://example.com/b.png")).toBe(false);
    expect(hasUrl("ses_other", "https://example.com/a.png")).toBe(false);
  });

  test("per-session cap refuses further artifacts", () => {
    for (let i = 0; i < MAX_ARTIFACTS_PER_SESSION; i++) {
      // Vary two bytes so every artifact hashes differently.
      const bytes = fakePng(i % 256);
      bytes[9] = Math.floor(i / 256);
      expect(addArtifact("ses_cap", { kind: "image", bytes, ...base, url: `https://x.example/${i}` })).not.toBeNull();
    }
    const over = fakePng(99);
    over[10] = 99;
    expect(addArtifact("ses_cap", { kind: "image", bytes: over, ...base, url: "https://x.example/over" })).toBeNull();
    expect(readIndex("ses_cap")).toHaveLength(MAX_ARTIFACTS_PER_SESSION);
  });

  test("unsafe session ids never touch the filesystem", () => {
    expect(addArtifact("../../etc", { kind: "image", bytes: fakePng(), ...base })).toBeNull();
    expect(readIndex("../../etc")).toEqual([]);
    expect(artifactFilePath("../../etc", "a".repeat(64))).toBeNull();
  });
});
