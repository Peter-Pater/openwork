import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { spatialEventsBroker } from "../../events.js";

import { createArtifactWatcher, extractUrls, looksLikeDataEndpoint, type ArtifactWatcher } from "./artifact-watcher.js";
import { readIndex } from "./session-artifact-store.js";

let dataDir: string;
let previousDataDir: string | undefined;
let watcher: ArtifactWatcher | null = null;

type CaptureCall = { requestId: string; url: string };

function fakeChannel(connected = true) {
  const calls: CaptureCall[] = [];
  return {
    calls,
    hasController: () => connected,
    requestCaptureArtifact: (requestId: string, url: string) => {
      calls.push({ requestId, url });
    },
  };
}

function toolPart(overrides: Record<string, unknown> = {}) {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        type: "tool",
        tool: "webfetch",
        callID: "call_1",
        sessionID: "ses_w1",
        state: { status: "running", input: { url: "https://example.com/page" } },
        ...overrides,
      },
    },
  };
}

const PNG_B64 = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([1, 2, 3, 4]),
]).toString("base64");

beforeEach(() => {
  previousDataDir = process.env.OPENWORK_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "openwork-watcher-"));
  process.env.OPENWORK_DATA_DIR = dataDir;
});

afterEach(() => {
  watcher?.stop();
  watcher = null;
  if (previousDataDir === undefined) delete process.env.OPENWORK_DATA_DIR;
  else process.env.OPENWORK_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("artifacts: watcher trigger", () => {
  test("captures on running, ignores pending, dedupes on callID", () => {
    const channel = fakeChannel();
    watcher = createArtifactWatcher(channel);
    watcher.start();

    // Pending precedes the permission gate -- must not trigger.
    spatialEventsBroker.emit(toolPart({ state: { status: "pending", input: { url: "https://example.com/page" } } }));
    expect(channel.calls).toHaveLength(0);

    spatialEventsBroker.emit(toolPart());
    expect(channel.calls).toHaveLength(1);
    expect(channel.calls[0].url).toBe("https://example.com/page");

    // Same callID advances state repeatedly; only the first running counts.
    spatialEventsBroker.emit(toolPart());
    expect(channel.calls).toHaveLength(1);
  });

  test("ignores non-webfetch tools and unusable urls", () => {
    const channel = fakeChannel();
    watcher = createArtifactWatcher(channel);
    watcher.start();

    spatialEventsBroker.emit(toolPart({ tool: "websearch", callID: "call_ws" }));
    spatialEventsBroker.emit(toolPart({ callID: "call_ftp", state: { status: "running", input: { url: "ftp://x" } } }));
    spatialEventsBroker.emit(toolPart({ callID: "call_nourl", state: { status: "running", input: {} } }));
    expect(channel.calls).toHaveLength(0);
  });

  test("drops cleanly when no capture controller is connected", () => {
    const channel = fakeChannel(false);
    watcher = createArtifactWatcher(channel);
    watcher.start();
    spatialEventsBroker.emit(toolPart());
    expect(channel.calls).toHaveLength(0);
  });
});

describe("artifacts: watcher ingest", () => {
  test("stores the capture and announces spatial_artifact_added with the entry", () => {
    const channel = fakeChannel();
    watcher = createArtifactWatcher(channel);
    watcher.start();
    spatialEventsBroker.emit(toolPart());
    const { requestId } = channel.calls[0];

    const announced: any[] = [];
    const listener = (event: any) => {
      if (event?.type === "spatial_artifact_added") announced.push(event);
    };
    spatialEventsBroker.addListener(listener);
    try {
      watcher!.ingest(requestId, {
        ok: true,
        kind: "page",
        base64: PNG_B64,
        finalUrl: "https://example.com/page/",
        title: "Example",
        width: 1280,
        height: 800,
      });
    } finally {
      spatialEventsBroker.removeListener(listener);
    }

    const index = readIndex("ses_w1");
    expect(index).toHaveLength(1);
    expect(index[0].kind).toBe("page");
    expect(index[0].title).toBe("Example");
    expect(announced).toHaveLength(1);
    expect(announced[0].properties.sessionId).toBe("ses_w1");
    expect(announced[0].properties.entry.id).toBe(index[0].id);

    // A re-fetch of a stored URL is a no-op before any capture is commanded.
    spatialEventsBroker.emit(toolPart({ callID: "call_2" }));
    expect(channel.calls).toHaveLength(1);
  });

  test("refuses failed, oversized, and unknown-request payloads", () => {
    const channel = fakeChannel();
    watcher = createArtifactWatcher(channel);
    watcher.start();
    spatialEventsBroker.emit(toolPart());
    const { requestId } = channel.calls[0];

    watcher!.ingest("art_unknown_9", { ok: true, kind: "page", base64: PNG_B64 });
    watcher!.ingest(requestId, { ok: false, error: "load timeout" });
    expect(readIndex("ses_w1")).toHaveLength(0);

    // The request is consumed by the failed ingest above; a late success for
    // the same id must not resurrect it.
    watcher!.ingest(requestId, { ok: true, kind: "page", base64: PNG_B64 });
    expect(readIndex("ses_w1")).toHaveLength(0);
  });
});

describe("artifacts: extractUrls", () => {
  test("finds unique http(s) URLs anywhere in a nested input, trimming punctuation", () => {
    const input = {
      extensionId: "google-workspace",
      action: "slides_batch_update",
      args: {
        requests: [
          { createImage: { url: "https://upload.wikimedia.org/wikipedia/commons/6/6c/Lionel_Messi_in_2018.jpg" } },
          { createImage: { url: "https://upload.wikimedia.org/wikipedia/commons/6/6c/Lionel_Messi_in_2018.jpg" } },
          { note: "see (https://example.com/page)." },
        ],
      },
    };
    const urls = extractUrls(input);
    expect(urls).toEqual([
      "https://upload.wikimedia.org/wikipedia/commons/6/6c/Lionel_Messi_in_2018.jpg",
      "https://example.com/page",
    ]);
  });

  test("caps the URL count and survives non-JSON input", () => {
    const many = { urls: Array.from({ length: 20 }, (_, i) => `https://x.example/${i}`) };
    expect(extractUrls(many)).toHaveLength(8);
    expect(extractUrls(undefined)).toEqual([]);
    expect(extractUrls("no urls here")).toEqual([]);
  });
});

describe("artifacts: extension-call trigger (image-only)", () => {
  function extensionPart(callID: string, input: unknown) {
    return {
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          tool: "openwork_extension_call",
          callID,
          sessionID: "ses_ext1",
          state: { status: "running", input },
        },
      },
    };
  }

  test("requests an image-only capture per URL in the input", () => {
    const channel = fakeChannel();
    watcher = createArtifactWatcher(channel);
    watcher.start();
    spatialEventsBroker.emit(extensionPart("call_ext1", {
      action: "slides_batch_update",
      args: { requests: [
        { createImage: { url: "https://img.example/a.jpg" } },
        { createImage: { url: "https://img.example/b.jpg" } },
      ] },
    }));
    expect(channel.calls.map((c) => c.url)).toEqual([
      "https://img.example/a.jpg",
      "https://img.example/b.jpg",
    ]);
  });

  test("stores an image result but drops a page result", () => {
    const channel = fakeChannel();
    watcher = createArtifactWatcher(channel);
    watcher.start();
    spatialEventsBroker.emit(extensionPart("call_ext2", {
      args: { a: "https://img.example/real.png", b: "https://docs.google.com/presentation/d/xyz" },
    }));
    expect(channel.calls).toHaveLength(2);

    // The genuine image is stored...
    watcher!.ingest(channel.calls[0].requestId, { ok: true, kind: "image", base64: PNG_B64 });
    expect(readIndex("ses_ext1")).toHaveLength(1);
    expect(readIndex("ses_ext1")[0].kind).toBe("image");

    // ...a page payload for an image-only request is refused, even if the
    // capture side (wrongly) rendered and returned one.
    watcher!.ingest(channel.calls[1].requestId, { ok: true, kind: "page", base64: PNG_B64 });
    expect(readIndex("ses_ext1")).toHaveLength(1);
  });
});

test("looksLikeDataEndpoint flags API and feed URLs, not pages", () => {
  expect(looksLikeDataEndpoint("https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=x&format=json")).toBe(true);
  expect(looksLikeDataEndpoint("https://example.com/api/v1/items")).toBe(true);
  expect(looksLikeDataEndpoint("https://example.com/data.json")).toBe(true);
  expect(looksLikeDataEndpoint("https://example.com/feed.xml")).toBe(true);
  expect(looksLikeDataEndpoint("https://en.wikipedia.org/wiki/Belgium")).toBe(false);
  expect(looksLikeDataEndpoint("https://www.fifa.com/tournaments/mens/worldcup/2026")).toBe(false);
  expect(looksLikeDataEndpoint("https://upload.wikimedia.org/wikipedia/commons/thumb/a/ae/x.jpg/500px-x.jpg")).toBe(false);
});
