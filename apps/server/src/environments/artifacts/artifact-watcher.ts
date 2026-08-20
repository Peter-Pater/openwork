import { spatialEventsBroker } from "../../events.js";

import {
  addArtifact,
  hasUrl,
  type SessionArtifactEntry,
  type SessionArtifactKind,
} from "./session-artifact-store.js";

/**
 * Observes the agents' webfetch activity and turns it into stored artifacts.
 *
 * Listens on spatialEventsBroker for `message.part.updated` tool parts exactly
 * the way spatial-stream-relay's coordinator does, filters `tool ===
 * "webfetch"`, and commands the Electron capture controller (over the stream
 * relay's JSON-RPC channel) to fetch/snapshot the URL on the app's logged-in
 * browser partition. Results come back through `ingest()`, get stored via
 * session-artifact-store, and are announced to XR clients as a synthetic
 * `spatial_artifact_added` SSE event.
 *
 * Two deliberate choices, both load-bearing:
 *
 *  - **Trigger on `status === "running"`, never `pending`.** Pending fires
 *    before opencode's webfetch permission gate; capturing there would archive
 *    URLs the user explicitly denied. Running means the fetch was approved and
 *    is actually happening -- and it still precedes `completed`, so the capture
 *    runs concurrently with the agent's own fetch.
 *
 *  - **Only the URL is read from the part.** The opencode binary ships two
 *    webfetch implementations (one returns images as attachments, one rejects
 *    image content types outright); which is live depends on a runtime flag.
 *    `state.input.url` is the one thing both populate, so the piles fill
 *    identically under either -- we never depend on what webfetch returned.
 *
 * ## Second trigger: URLs inside openwork_extension_call inputs
 *
 * Observed in practice (the Messi test): the agent inserted images into a
 * Slides deck WITHOUT ever downloading them -- it found URLs via a Commons
 * API script in bash and handed the bare URLs to the Google Workspace
 * extension, which had Slides fetch them server-side. No image bytes passed
 * through any observable tool, so no persona instruction about webfetch can
 * cover this flow; the URLs themselves traveling through the extension call
 * are the only footprint. So extension-call inputs are scanned for http(s)
 * URLs and each unseen one is captured **image-only**: bytes that sniff as an
 * image join the image pile ("pictures the agent put into your documents"),
 * anything else is dropped rather than snapshotted -- the page pile stays
 * strictly "webpages the agent read", not "every URL that passed by".
 *
 * No role gate here, and that is not an oversight: chef's frontmatter is a
 * deny-all allow-list without webfetch, so it cannot trigger this at all;
 * secretary/companion are the ones with the tools. The client additionally
 * gates rendering per-role (gathersArtifacts in AgentRoster).
 */

/** How the watcher talks to the capture side -- the stream relay in production. */
export type ArtifactCaptureChannel = {
  hasController(): boolean;
  requestCaptureArtifact(requestId: string, url: string, options?: { imageOnly?: boolean }): void;
};

export type ArtifactCapturePayload = {
  ok: boolean;
  kind?: SessionArtifactKind;
  /** base64 of the bytes (no data: prefix). */
  base64?: string;
  finalUrl?: string;
  title?: string | null;
  width?: number | null;
  height?: number | null;
  error?: string;
};

export type ArtifactWatcher = {
  start(): void;
  stop(): void;
  /** Relay routes `artifactStore.ingest(requestId, payload)` here. */
  ingest(requestId: string, payload: unknown): void;
};

/**
 * Whole-round-trip timeout. The Electron side has its own ~15s per-page load
 * timeout plus a FIFO queue, so a burst of fetches can legitimately take a
 * while; this is the backstop for a capture controller that died mid-queue.
 */
const REQUEST_TIMEOUT_MS = 60_000;

/** Matches the existing screenshot cap (server.ts's 10MB data-URL limit). */
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

/** Remembered callIDs, capped so a long-lived server doesn't grow forever. */
const SEEN_CALLS_CAP = 500;

type PendingCapture = {
  sessionId: string;
  url: string;
  imageOnly: boolean;
  timer: ReturnType<typeof setTimeout>;
};

/** Most URLs considered from a single extension call (a big batchUpdate can carry dozens). */
const MAX_URLS_PER_CALL = 8;

const URL_RE = /https?:\/\/[^\s"'\\<>]+/g;

/**
 * http(s) URLs inside a JSON-stringified tool input. The regex ends a URL at
 * quotes, whitespace, or JSON escapes; trailing punctuation is then trimmed.
 */
export function extractUrls(value: unknown): string[] {
  let text: string;
  try {
    text = JSON.stringify(value) ?? "";
  } catch {
    return [];
  }
  const found = text.match(URL_RE) ?? [];
  const urls: string[] = [];
  for (const raw of found) {
    const url = raw.replace(/[),.\]}!;]+$/, "");
    if (!urls.includes(url)) urls.push(url);
    if (urls.length >= MAX_URLS_PER_CALL) break;
  }
  return urls;
}

export function createArtifactWatcher(channel: ArtifactCaptureChannel): ArtifactWatcher {
  const seenCalls = new Set<string>();
  const pending = new Map<string, PendingCapture>();
  let requestSeq = 0;
  let listening = false;

  function rememberCall(callID: string): void {
    seenCalls.add(callID);
    if (seenCalls.size > SEEN_CALLS_CAP) {
      // Sets iterate in insertion order; drop the oldest half.
      const iterator = seenCalls.values();
      for (let i = 0; i < SEEN_CALLS_CAP / 2; i++) {
        const next = iterator.next();
        if (next.done) break;
        seenCalls.delete(next.value);
      }
    }
  }

  function requestCapture(sessionId: string, url: string, imageOnly: boolean): void {
    if (hasUrl(sessionId, url)) {
      console.log(`[Artifacts] ${url} already captured for session ${sessionId}; skipped.`);
      return;
    }
    if (!channel.hasController()) {
      // Server running without the desktop app. One clear line, no retry
      // queue -- a pile that silently backfills minutes later is more
      // confusing than one that says why it is empty.
      console.log(`[Artifacts] No capture controller connected; dropping ${url}.`);
      return;
    }
    const requestId = `art_${Date.now().toString(36)}_${++requestSeq}`;
    const timer = setTimeout(() => {
      if (pending.delete(requestId)) {
        console.warn(`[Artifacts] Capture timed out for ${url} (session ${sessionId}).`);
      }
    }, REQUEST_TIMEOUT_MS);
    pending.set(requestId, { sessionId, url, imageOnly, timer });
    console.log(
      `[Artifacts] Capturing ${url} for session ${sessionId} (${requestId}${imageOnly ? ", image-only" : ""}).`,
    );
    channel.requestCaptureArtifact(requestId, url, { imageOnly });
  }

  function onBrokerEvent(event: any): void {
    if (!event || event.type !== "message.part.updated") return;
    const part = event.properties?.part;
    if (!part || part.type !== "tool") return;
    const tool = part.tool;
    if (tool !== "webfetch" && tool !== "openwork_extension_call") return;
    if (part.state?.status !== "running") return;

    const callID = typeof part.callID === "string" ? part.callID : null;
    const sessionId = typeof part.sessionID === "string" ? part.sessionID : null;
    if (!callID || !sessionId) return;
    if (seenCalls.has(callID)) return;
    rememberCall(callID);

    if (tool === "webfetch") {
      // Defensive on the input shape: two webfetch implementations today, and
      // no guarantee a third keeps the key. Log-and-skip beats a wrong capture.
      const url = typeof part.state?.input?.url === "string" ? part.state.input.url.trim() : "";
      if (!/^https?:\/\//i.test(url)) {
        console.log(`[Artifacts] webfetch part without a usable url (callID ${callID}); skipped.`);
        return;
      }
      requestCapture(sessionId, url, false);
      return;
    }

    // openwork_extension_call: every URL the agent handed to an extension
    // (e.g. an image inserted into Slides by URL), captured image-only --
    // whatever does not sniff as an image is dropped, so a docs.google.com
    // link in the args can never pollute the page pile. See the header.
    for (const url of extractUrls(part.state?.input)) {
      requestCapture(sessionId, url, true);
    }
  }

  function ingest(requestId: string, rawPayload: unknown): void {
    const request = pending.get(requestId);
    if (!request) return; // timed out, or a stale/duplicate reply
    pending.delete(requestId);
    clearTimeout(request.timer);

    const payload = (rawPayload ?? {}) as ArtifactCapturePayload;
    if (!payload.ok || typeof payload.base64 !== "string") {
      // Routine for image-only requests: most URLs in an extension call are
      // API endpoints and document links, not pictures.
      console.warn(`[Artifacts] Capture failed for ${request.url}: ${payload.error ?? "no payload"}.`);
      return;
    }
    const kind: SessionArtifactKind = payload.kind === "image" ? "image" : "page";
    if (request.imageOnly && kind !== "image") {
      console.log(`[Artifacts] ${request.url} is not an image; dropped (image-only request).`);
      return;
    }

    let bytes: Buffer;
    try {
      bytes = Buffer.from(payload.base64, "base64");
    } catch {
      console.warn(`[Artifacts] Undecodable capture payload for ${request.url}.`);
      return;
    }
    if (bytes.length === 0 || bytes.length > MAX_ARTIFACT_BYTES) {
      console.warn(`[Artifacts] Capture for ${request.url} is ${bytes.length} bytes; dropped.`);
      return;
    }

    const entry: SessionArtifactEntry | null = addArtifact(request.sessionId, {
      kind,
      url: request.url,
      finalUrl: typeof payload.finalUrl === "string" && payload.finalUrl ? payload.finalUrl : request.url,
      title: typeof payload.title === "string" && payload.title ? payload.title : null,
      bytes,
      width: typeof payload.width === "number" ? payload.width : null,
      height: typeof payload.height === "number" ? payload.height : null,
    });
    if (!entry) {
      // Byte-identical dedupe, cap, or a payload that failed the image sniff.
      console.log(`[Artifacts] Capture for ${request.url} not stored (duplicate, cap, or sniff).`);
      return;
    }

    console.log(`[Artifacts] Stored ${entry.kind} ${entry.id.slice(0, 12)}… for session ${request.sessionId}.`);
    // Carries the full entry so the XR client appends directly instead of
    // refetching the index. Emitted straight onto the broker: the opencode
    // allow-list filter sits on the subscription, not here, so a synthetic
    // type flows through the existing SSE serializer untouched.
    spatialEventsBroker.emit({
      type: "spatial_artifact_added",
      properties: { sessionId: request.sessionId, entry },
    });
  }

  return {
    start() {
      if (listening) return;
      listening = true;
      spatialEventsBroker.addListener(onBrokerEvent);
    },
    stop() {
      if (!listening) return;
      listening = false;
      spatialEventsBroker.removeListener(onBrokerEvent);
      for (const request of pending.values()) clearTimeout(request.timer);
      pending.clear();
    },
    ingest,
  };
}
