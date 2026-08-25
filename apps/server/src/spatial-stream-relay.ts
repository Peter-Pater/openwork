/**
 * WebSocket relay + coordinator for the XR "virtual screens" feature.
 *
 * Three kinds of clients connect to a single WebSocket endpoint
 * (`/experimental/spatial/stream`):
 *
 *   - **capture controller** (Electron main): opens a browser window per agent
 *     session and pushes JPEG frames. Registers via `captureController.register`,
 *     then acts as the *sender* for one stream per session.
 *   - **receivers** (XR clients): poll `streamManager.get_active_streams`,
 *     `subscribe_to_stream`, and render incoming binary frames.
 *
 * The wire protocol intentionally matches xrblocks' `virtual_screens` sample so
 * its receiver code (WebSocketManager/StreamManager) is reusable unchanged:
 *   - JSON-RPC text frames: `{ id, params: { target, func, args } }` and replies
 *     `{ id, result?, error? }`; server→client calls omit `id`.
 *   - Binary frames: `[uint8 streamIdLen][streamId][uint8 frameType][payload]`.
 *
 * The relay is transport-only; it never decodes frames. The coordinator decides
 * *when* a stream should exist (artifact-gated, driven by session status) and
 * asks the capture controller to start/stop via control RPCs.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket, type RawData } from "ws";

import { spatialEventsBroker } from "./events.js";

export const SPATIAL_STREAM_PATH = "/experimental/spatial/stream";

type StreamInfo = { width: number; height: number };

/**
 * What a session's stream should show. The capture controller branches on
 * `kind`: `browser` opens a hidden BrowserWindow at `url` (GWS artifacts);
 * `screen` captures the primary display (computer-use sessions). Adding a
 * `window` kind later (focused-app capture) is a drop-in third case — the
 * relay, wire protocol, and XR receiver are all kind-agnostic.
 */
export type SpatialStreamTarget = { kind: "browser"; url: string } | { kind: "screen" };

type StreamEntry = {
  info: StreamInfo;
  sender: WebSocket | null;
  receivers: Set<WebSocket>;
};

export type SpatialStreamRelay = {
  /**
   * Handle an HTTP upgrade. Returns true if the request was for the stream
   * endpoint (and was taken over), false otherwise (caller should destroy).
   */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  /** Ask the connected capture controller(s) to open + stream a target. */
  requestStartStream(streamId: string, target: SpatialStreamTarget): void;
  /** Ask the connected capture controller(s) to re-point an open window's URL. */
  requestUpdateStream(streamId: string, url: string): void;
  /** Ask the connected capture controller(s) to stop + close a window. */
  requestStopStream(streamId: string): void;
  /**
   * Ask the capture controller to fetch/snapshot a URL for the artifact piles
   * (see environments/artifacts/artifact-watcher.ts). Fire-and-forget like the
   * other controller calls -- the result comes back as an
   * `artifactStore.ingest(requestId, payload)` call in the other direction,
   * routed to the handler set below. `requestId` correlates the two legs.
   */
  requestCaptureArtifact(requestId: string, url: string, options?: { imageOnly?: boolean }): void;
  /** Route incoming `artifactStore.ingest` calls (from Electron) to a handler. */
  setArtifactIngestHandler(handler: ((requestId: string, payload: unknown) => void) | null): void;
  /**
   * Route incoming `screenControl.stepSlide(sessionId, delta)` calls (from an
   * XR receiver paging a waiting agent's deck) to a handler; the handler's
   * return value is the RPC reply.
   */
  setScreenControlHandler(handler: ((sessionId: string, delta: number) => unknown) | null): void;
  /** Whether at least one capture controller is currently connected. */
  hasController(): boolean;
  /** Terminate all live sockets (keeps the server reusable across restarts). */
  disconnectClients(): void;
  close(): void;
};

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      /* socket closing */
    }
  }
}

function call(ws: WebSocket, target: string, func: string, args: unknown[]): void {
  sendJson(ws, { params: { target, func, args } });
}

function reply(ws: WebSocket, id: unknown, result: unknown, error?: string): void {
  if (id === undefined) return;
  sendJson(ws, error ? { id, error } : { id, result });
}

export function createSpatialStreamRelay(): SpatialStreamRelay {
  const wss = new WebSocketServer({ noServer: true });
  const streams = new Map<string, StreamEntry>();
  const controllers = new Set<WebSocket>();
  let artifactIngestHandler: ((requestId: string, payload: unknown) => void) | null = null;
  let screenControlHandler: ((sessionId: string, delta: number) => unknown) | null = null;

  function endStream(streamId: string, sender: WebSocket | null): void {
    const entry = streams.get(streamId);
    if (!entry) return;
    if (sender && entry.sender !== sender) return;
    for (const receiver of entry.receivers) {
      call(receiver, "streamManager", "onStreamEnded", [streamId]);
    }
    streams.delete(streamId);
  }

  function handleStreamManager(ws: WebSocket, id: unknown, func: string, args: unknown[]): void {
    switch (func) {
      case "start_stream": {
        const streamId = String(args[0] ?? "");
        const info = (args[1] ?? {}) as StreamInfo;
        if (!streamId) return reply(ws, id, null, "missing streamId");
        const existing = streams.get(streamId);
        if (existing) {
          existing.info = info;
          existing.sender = ws;
        } else {
          streams.set(streamId, { info, sender: ws, receivers: new Set() });
        }
        return reply(ws, id, { ok: true });
      }
      case "stop_stream": {
        const streamId = String(args[0] ?? "");
        endStream(streamId, ws);
        return reply(ws, id, { ok: true });
      }
      case "get_active_streams": {
        const out: Record<string, StreamInfo> = {};
        for (const [streamId, entry] of streams) out[streamId] = entry.info;
        return reply(ws, id, out);
      }
      case "subscribe_to_stream": {
        const streamId = String(args[0] ?? "");
        const entry = streams.get(streamId);
        if (entry && entry.sender) {
          entry.receivers.add(ws);
          // Ask the sender for a fresh keyframe so this receiver can start.
          call(entry.sender, "streamManager", "triggerKeyFrame", [streamId]);
          return reply(ws, id, { ok: true });
        }
        return reply(ws, id, { ok: false });
      }
      default:
        return reply(ws, id, null, `unknown streamManager func: ${func}`);
    }
  }

  function handleText(ws: WebSocket, raw: string): void {
    let msg: { id?: unknown; params?: { target?: string; func?: string; args?: unknown[] } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const params = msg.params;
    if (!params || typeof params.func !== "string") return;
    const args = Array.isArray(params.args) ? params.args : [];
    if (params.target === "streamManager") {
      handleStreamManager(ws, msg.id, params.func, args);
    } else if (params.target === "captureController") {
      if (params.func === "register") {
        controllers.add(ws);
        reply(ws, msg.id, { ok: true });
      }
    } else if (params.target === "artifactStore") {
      // Electron returning a captureArtifact result (see requestCaptureArtifact).
      if (params.func === "ingest") {
        try {
          artifactIngestHandler?.(String(args[0] ?? ""), args[1]);
        } catch (err) {
          console.error("[Artifacts] ingest handler failed:", err);
        }
        reply(ws, msg.id, { ok: true });
      }
    } else if (params.target === "screenControl") {
      // An XR receiver paging the deck shown on a waiting agent's screen.
      if (params.func === "stepSlide") {
        const delta = Number(args[1]);
        let result: unknown = { ok: false };
        try {
          result = screenControlHandler?.(String(args[0] ?? ""), Number.isFinite(delta) ? delta : 0) ?? { ok: false };
        } catch (err) {
          console.error("[SpatialStream] screenControl handler failed:", err);
        }
        reply(ws, msg.id, result);
      }
    }
  }

  function handleBinary(ws: WebSocket, data: Buffer): void {
    if (data.length < 1) return;
    const idLen = data[0];
    if (data.length < 1 + idLen) return;
    const streamId = data.toString("utf8", 1, 1 + idLen);
    const entry = streams.get(streamId);
    if (!entry || entry.sender !== ws) return;
    for (const receiver of entry.receivers) {
      if (receiver.readyState === WebSocket.OPEN) {
        try {
          receiver.send(data);
        } catch {
          /* dropped frame */
        }
      }
    }
  }

  function handleDisconnect(ws: WebSocket): void {
    controllers.delete(ws);
    const toEnd: string[] = [];
    for (const [streamId, entry] of streams) {
      if (entry.sender === ws) toEnd.push(streamId);
      else entry.receivers.delete(ws);
    }
    for (const streamId of toEnd) endStream(streamId, ws);
  }

  wss.on("connection", (ws: WebSocket) => {
    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        handleBinary(ws, data as Buffer);
      } else {
        handleText(ws, data.toString());
      }
    });
    ws.on("close", () => handleDisconnect(ws));
    ws.on("error", () => handleDisconnect(ws));
  });

  return {
    handleUpgrade(request, socket, head) {
      const path = (request.url ?? "").split("?")[0];
      if (path !== SPATIAL_STREAM_PATH) return false;
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
      return true;
    },
    requestStartStream(streamId, target) {
      for (const controller of controllers) {
        call(controller, "captureController", "startStream", [streamId, target]);
      }
    },
    requestUpdateStream(streamId, url) {
      for (const controller of controllers) {
        call(controller, "captureController", "updateStream", [streamId, url]);
      }
    },
    requestStopStream(streamId) {
      for (const controller of controllers) {
        call(controller, "captureController", "stopStream", [streamId]);
      }
    },
    requestCaptureArtifact(requestId, url, options = {}) {
      for (const controller of controllers) {
        call(controller, "captureController", "captureArtifact", [requestId, url, options]);
      }
    },
    setArtifactIngestHandler(handler) {
      artifactIngestHandler = handler;
    },
    setScreenControlHandler(handler) {
      screenControlHandler = handler;
    },
    hasController() {
      return controllers.size > 0;
    },
    // Terminate all live sockets without closing the (reusable) WebSocketServer.
    // Called on server stop/restart so upgraded sockets don't block the HTTP
    // server's close(); the relay keeps working for the next server instance.
    disconnectClients() {
      for (const ws of wss.clients) {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
      }
      streams.clear();
      controllers.clear();
    },
    close() {
      for (const ws of wss.clients) {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
      }
      wss.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Coordinator: decides *when* a per-session stream should exist.
// ---------------------------------------------------------------------------

export type SpatialStreamCoordinator = {
  /**
   * Record that a session is working on a Google Doc and (optimistically) start
   * streaming its visualization. Idempotent per session.
   */
  noteSessionDoc(sessionId: string, fileId: string): void;
  /**
   * Record that a session is viewing/working on a specific URL. Starts the
   * stream if not already running; re-points the existing window (keeping the
   * same panel) if the URL changed — i.e. the agent switched documents.
   */
  noteSessionUrl(sessionId: string, url: string): void;
  /**
   * Inspect a completed `openwork_extension_call` and, if it touched a viewable
   * Google Workspace artifact, start/re-point that session's stream. This is the
   * general trigger: it fires for desktop-prompted sessions too, not just XR
   * drops. `body` is the request payload (`{ extensionId, action, args, context
   * }`); `callResult` is the action's return value (carries created file ids).
   */
  noteExtensionCall(body: unknown, callResult: unknown): void;
  /**
   * Record that a session is driving the machine via computer-use and stream its
   * (primary display) screen. Idempotent — safe to call on every computer-use
   * tool part. Screen capture is comprehensive, so it takes precedence over a
   * browser-URL stream for the same session.
   */
  noteSessionComputerUse(sessionId: string): void;
  /**
   * Keep a session's stream alive through its next idle transition --
   * used by the busy-interruption abort call so the avatar's screen doesn't
   * disappear while the user decides what to prompt next. Idempotent;
   * release with releaseHold once a new prompt is sent.
   */
  holdSessionOpen(sessionId: string): void;
  /** Undo holdSessionOpen -- normal idle teardown behavior resumes. */
  releaseHold(sessionId: string): void;
  /**
   * Explicitly stop a session's stream and forget its target/hold. Used when
   * an awaiting-command standby (screen opened without any backend run) is
   * cancelled without a prompt ever being sent -- there is no idle
   * transition coming to tear the stream down naturally.
   */
  stopSession(sessionId: string): void;
  /**
   * Page the deck on a session's screen by `delta` slides (clamped to the
   * known slide order). Used while the agent is waiting for input; while it
   * works, the screen follows the slide the agent edits instead. Returns
   * `{ ok: false }` when the session has no presentation on screen.
   */
  stepSlide(sessionId: string, delta: number): { ok: boolean; index?: number; count?: number };
  /**
   * Install the Slides API reader used to learn a deck's slide order (needs a
   * server config, which the module singleton does not have). Without one the
   * screen still follows explicit `createSlide` ids, but cannot resolve
   * element ids to their slide or page a deck the agent never read.
   */
  setSlideOutlineFetcher(fetcher: ((presentationId: string) => Promise<SlideOutline | null>) | null): void;
  dispose(): void;
};

/** Ordered slides of a presentation with the ids of the elements on each. */
export type SlideOutline = { slideIds: string[]; elementToSlide: Record<string, string> };

/**
 * Builds a SlideOutline from a Slides API `Presentation` resource (as returned
 * by `presentations.get`, possibly narrowed with a `fields` mask). Null when
 * the payload has no `slides` array.
 */
export function slideOutlineFromPresentation(presentation: unknown): SlideOutline | null {
  if (!presentation || typeof presentation !== "object") return null;
  const slides = (presentation as Record<string, unknown>).slides;
  if (!Array.isArray(slides)) return null;
  const slideIds: string[] = [];
  const elementToSlide: Record<string, string> = {};
  for (const slide of slides) {
    if (!slide || typeof slide !== "object") continue;
    const id = asString((slide as Record<string, unknown>).objectId);
    if (!id) continue;
    slideIds.push(id);
    const elements = (slide as Record<string, unknown>).pageElements;
    if (!Array.isArray(elements)) continue;
    for (const el of elements) {
      const elId = el && typeof el === "object" ? asString((el as Record<string, unknown>).objectId) : "";
      if (elId) elementToSlide[elId] = id;
    }
  }
  return { slideIds, elementToSlide };
}

/**
 * The slide a `slides_update_presentation` call worked on: the target of the
 * LAST request in the batch that names one (later requests are what the
 * agent is "on"). A request names a slide directly (`createSlide.objectId`,
 * `deleteObject.objectId` of a slide, `elementProperties.pageObjectId`) or
 * through an element it edits (`insertText.objectId`, ...), which is resolved
 * via `outline.elementToSlide`. A `createSlide` without an explicit id takes
 * the generated one from the matching `replies[i]`. Returns the page object
 * id, or null when nothing in the batch can be tied to a slide.
 */
export function slideTargetFromCall(action: string, args: unknown, callResult: unknown, outline: SlideOutline | null): string | null {
  if (action !== "slides_update_presentation") return null;
  const requests = args && typeof args === "object" ? (args as Record<string, unknown>).requests : undefined;
  if (!Array.isArray(requests)) return null;
  const result = callResult && typeof callResult === "object" ? (callResult as Record<string, unknown>).result : undefined;
  const replies = result && typeof result === "object" && Array.isArray((result as Record<string, unknown>).replies)
    ? ((result as Record<string, unknown>).replies as unknown[])
    : [];
  const slideSet = new Set(outline?.slideIds ?? []);
  const toSlide = (objectId: string): string | null => {
    if (!objectId) return null;
    if (slideSet.has(objectId)) return objectId;
    return outline?.elementToSlide[objectId] ?? null;
  };
  for (let i = requests.length - 1; i >= 0; i--) {
    const req = requests[i];
    if (!req || typeof req !== "object") continue;
    const r = req as Record<string, unknown>;
    const createSlide = r.createSlide;
    if (createSlide && typeof createSlide === "object") {
      const explicit = asString((createSlide as Record<string, unknown>).objectId);
      if (explicit) return explicit;
      const reply = replies[i];
      const created = reply && typeof reply === "object" ? (reply as Record<string, unknown>).createSlide : undefined;
      const generated = created && typeof created === "object" ? asString((created as Record<string, unknown>).objectId) : "";
      if (generated) return generated;
      continue;
    }
    for (const body of Object.values(r)) {
      const page = slideFromRequestBody(body, toSlide);
      if (page) return page;
    }
  }
  return null;
}

// Slides requests name their target under many keys (`objectId`,
// `imageObjectId`, `tableObjectId`, `elementProperties.pageObjectId`,
// `pageObjectIds`, ...). Walk the body and try every `*ObjectId(s)` string as
// a slide or an element on one; a page reference wins over an element one.
function slideFromRequestBody(body: unknown, toSlide: (objectId: string) => string | null): string | null {
  if (!body || typeof body !== "object") return null;
  let viaElement: string | null = null;
  const visit = (node: unknown): string | null => {
    if (!node || typeof node !== "object") return null;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const isIdKey = /objectids?$/i.test(key);
      if (isIdKey && typeof value === "string") {
        if (/^page/i.test(key)) return value;
        viaElement = viaElement ?? toSlide(value);
      } else if (isIdKey && Array.isArray(value)) {
        const first = value.find((v) => typeof v === "string") as string | undefined;
        if (first && /^page/i.test(key)) return first;
        if (first) viaElement = viaElement ?? toSlide(first);
      } else if (value && typeof value === "object") {
        const nested = visit(value);
        if (nested) return nested;
      }
    }
    return null;
  };
  return visit(body) ?? viaElement;
}

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
const SLIDE_MENTION_RE = new RegExp(`\\bslide\\s*#?\\s*(\\d{1,3})\\b|\\b(${ORDINALS.join("|")})\\s+slide\\b`, "gi");

/**
 * The 1-based slide number the text mentions last ("slide 3", "the third
 * slide"), or null. Used on the agent's reasoning so the screen turns to the
 * slide it is looking at, not only the one it eventually edits.
 */
export function lastSlideMention(text: string): number | null {
  let last: number | null = null;
  for (const m of text.matchAll(SLIDE_MENTION_RE)) {
    const n = m[1] ? Number(m[1]) : ORDINALS.indexOf(m[2].toLowerCase()) + 1;
    if (n > 0) last = n;
  }
  return last;
}

function presentationIdFromUrl(url: string): string | null {
  const m = /^https:\/\/docs\.google\.com\/presentation\/(?:u\/\d+\/)?d\/([^/?#]+)/.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}

const SLIDE_FRAGMENT_PREFIX = "#slide=id.";

/** Strip any `#slide=id.X` fragment so equal decks compare equal. */
function stripSlideFragment(url: string): string {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}

function slideUrl(baseUrl: string, pageObjectId: string): string {
  return `${stripSlideFragment(baseUrl)}${SLIDE_FRAGMENT_PREFIX}${encodeURIComponent(pageObjectId)}`;
}

function googleDocUrl(fileId: string): string {
  return `https://docs.google.com/document/d/${encodeURIComponent(fileId)}/edit`;
}

/**
 * Edit URL for a Google Workspace file by its Drive mime type. Falls back to
 * the Docs URL when the mime is missing/unknown (the historical behavior).
 */
export function googleWorkspaceEditUrl(fileId: string, mimeType?: string): string {
  const id = encodeURIComponent(fileId);
  if (mimeType === "application/vnd.google-apps.spreadsheet") {
    return `https://docs.google.com/spreadsheets/d/${id}/edit`;
  }
  if (mimeType === "application/vnd.google-apps.presentation") {
    return `https://docs.google.com/presentation/d/${id}/edit`;
  }
  return googleDocUrl(fileId);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Map a Google Workspace extension action + its args/result to the public
 * "anyone with the link" view URL for the artifact it touched, or null if the
 * action isn't tied to a viewable file. Reads the id from args first (read/
 * update actions) then from the call result (create actions return a new id).
 */
export function googleWorkspaceViewUrl(action: string, args: unknown, callResult: unknown): string | null {
  const fromArgsOrResult = (key: string): string => {
    const fromArgs = args && typeof args === "object" ? asString((args as Record<string, unknown>)[key]) : "";
    if (fromArgs) return fromArgs;
    const result = callResult && typeof callResult === "object" ? (callResult as Record<string, unknown>).result : undefined;
    return result && typeof result === "object" ? asString((result as Record<string, unknown>)[key]) : "";
  };
  const a = action || "";
  if (a.startsWith("docs_")) {
    const id = fromArgsOrResult("documentId");
    if (id) return googleDocUrl(id);
  } else if (a.startsWith("slides_")) {
    const id = fromArgsOrResult("presentationId");
    if (id) return `https://docs.google.com/presentation/d/${encodeURIComponent(id)}/edit`;
  } else if (a.startsWith("sheets_")) {
    const id = fromArgsOrResult("spreadsheetId");
    if (id) return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/edit`;
  } else if (a.startsWith("drive_")) {
    const id = fromArgsOrResult("fileId");
    if (id) return `https://drive.google.com/file/d/${encodeURIComponent(id)}/preview`;
  }
  return null;
}

/**
 * True if a tool name is a `computer-use` MCP tool. opencode namespaces MCP
 * tools with the server name ("computer-use"); we tolerate whatever separator
 * it sanitizes to (`computer-use_`, `computer_use_`, …) and also accept the
 * unambiguous `cua_*` compatibility tools in case the namespace is dropped.
 */
export function isComputerUseTool(toolName: unknown): boolean {
  if (typeof toolName !== "string") return false;
  return /computer[-_]?use[-_]/i.test(toolName) || /^cua_/i.test(toolName);
}

/**
 * Subscribes to `spatialEventsBroker` and maps session lifecycle → stream
 * lifecycle. A stream is only ever started for a session we know is working on a
 * viewable artifact (a Doc), so no-artifact tasks never open a window.
 */
export function createSpatialStreamCoordinator(relay: SpatialStreamRelay): SpatialStreamCoordinator {
  const targetBySession = new Map<string, SpatialStreamTarget>(); // sessionId -> what to show
  const streaming = new Set<string>(); // sessionIds with a live stream request
  const sawBusy = new Set<string>(); // sessionIds observed busy since last note
  const held = new Set<string>(); // sessionIds whose stream survives an idle transition (interrupted, not finished)
  // sessionId -> the deck on its screen. Kept across idle (the screen stays up
  // while the agent waits for input) and dropped with the session.
  type SlideState = { presentationId: string; baseUrl: string; outline: SlideOutline | null; current: string | null; refreshing: boolean };
  const slideBySession = new Map<string, SlideState>();
  let slideOutlineFetcher: ((presentationId: string) => Promise<SlideOutline | null>) | null = null;

  function startIfReady(sessionId: string): void {
    const target = targetBySession.get(sessionId);
    if (!target || streaming.has(sessionId)) return;
    streaming.add(sessionId);
    relay.requestStartStream(sessionId, target);
  }

  function noteSessionTarget(sessionId: string, target: SpatialStreamTarget): void {
    if (!sessionId || !target) return;
    const previous = targetBySession.get(sessionId);
    // Computer-use screen capture shows everything (any browser the agent opens
    // included), so never downgrade an active screen stream to a browser URL.
    if (previous?.kind === "screen" && target.kind === "browser") return;

    targetBySession.set(sessionId, target);

    if (!streaming.has(sessionId)) {
      startIfReady(sessionId); // optimistic head start (don't wait for "busy")
      return;
    }
    if (previous && previous.kind === target.kind) {
      // Doc switch mid-session: re-point the open window, keep the same panel.
      if (target.kind === "browser" && previous.kind === "browser" && previous.url !== target.url) {
        relay.requestUpdateStream(sessionId, target.url);
      }
      // screen → screen: nothing changes.
    } else {
      // Kind changed (e.g. browser → screen): restart; the capture controller
      // tears down the old window/renderer when it gets a new startStream.
      relay.requestStartStream(sessionId, target);
    }
  }

  function noteSessionUrl(sessionId: string, url: string): void {
    if (!sessionId || !url) return;
    noteSessionTarget(sessionId, { kind: "browser", url });
    // A deck put on screen by any route (the XR client opening it by file
    // id, a prompt carrying fileId) is pageable from the moment it shows:
    // learn its slide order now rather than waiting for the agent to read
    // it -- an interruption early in a run must still leave a browsable deck.
    const presentationId = presentationIdFromUrl(url);
    if (!presentationId) return;
    const state = slideStateFor(sessionId, presentationId, url);
    if (!state.outline) refreshOutline(sessionId, state);
  }

  function stop(sessionId: string): void {
    if (!streaming.has(sessionId)) return;
    streaming.delete(sessionId);
    relay.requestStopStream(sessionId);
  }

  function slideStateFor(sessionId: string, presentationId: string, baseUrl: string): SlideState {
    let state = slideBySession.get(sessionId);
    if (!state || state.presentationId !== presentationId) {
      state = { presentationId, baseUrl, outline: null, current: null, refreshing: false };
      slideBySession.set(sessionId, state);
    }
    return state;
  }

  // Re-read the slide order after an edit (fire-and-forget; one in flight per
  // session, a failure just keeps the previous outline). Also re-derives the
  // current slide for an edit that could not be resolved before the outline
  // arrived (an insertText on an element of a slide we had not seen yet).
  function refreshOutline(sessionId: string, state: SlideState, pending?: { action: string; args: unknown; callResult: unknown }): void {
    if (!slideOutlineFetcher || state.refreshing) return;
    state.refreshing = true;
    slideOutlineFetcher(state.presentationId)
      .then((outline) => {
        if (slideBySession.get(sessionId) !== state) return;
        if (outline) state.outline = outline;
        if (pending && outline) {
          const page = slideTargetFromCall(pending.action, pending.args, pending.callResult, outline);
          if (page) showSlide(sessionId, state, page);
        }
      })
      .catch((err) => console.warn(`[SpatialStream] slide outline refresh failed for ${state.presentationId}:`, err?.message ?? err))
      .finally(() => {
        state.refreshing = false;
      });
  }

  function showSlide(sessionId: string, state: SlideState, pageObjectId: string): void {
    if (state.current !== pageObjectId) console.log(`[SpatialStream] ${sessionId}: screen -> slide ${pageObjectId}`);
    state.current = pageObjectId;
    noteSessionUrl(sessionId, slideUrl(state.baseUrl, pageObjectId));
  }

  function noteSlidesCall(sessionId: string, action: string, args: unknown, callResult: unknown, baseUrl: string): void {
    const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    const result = callResult && typeof callResult === "object" ? (callResult as Record<string, unknown>).result : undefined;
    const presentationId = asString(a.presentationId) || (result && typeof result === "object" ? asString((result as Record<string, unknown>).presentationId) : "");
    if (!presentationId) return;
    const state = slideStateFor(sessionId, presentationId, baseUrl);
    // read/create return the whole Presentation resource: a free outline.
    const fromResult = action === "slides_read_presentation" || action === "slides_create_presentation" ? slideOutlineFromPresentation(result) : null;
    if (fromResult) state.outline = fromResult;
    if (action !== "slides_update_presentation") return;
    const page = slideTargetFromCall(action, args, callResult, state.outline);
    if (page) showSlide(sessionId, state, page);
    // The batch changed the deck (new slides, new elements): learn the new
    // shape, and resolve the target now if the stale outline could not.
    refreshOutline(sessionId, state, page ? undefined : { action, args, callResult });
  }

  const listener = (event: any) => {
    // Computer-use detection: any computer-use MCP tool part means the session
    // is driving the machine — stream its screen.
    if (event?.type === "message.part.updated") {
      const part = event.properties?.part ?? event.part;
      if (part?.type === "tool" && part.sessionID && isComputerUseTool(part.tool)) {
        noteSessionTarget(part.sessionID, { kind: "screen" });
      }
      // The agent thinking about "slide 3": turn to it while it inspects,
      // ahead of any edit (which re-points precisely by id when it lands).
      if (part?.type === "reasoning" && part.sessionID && typeof part.text === "string") {
        const state = slideBySession.get(part.sessionID);
        const ids = state?.outline?.slideIds ?? [];
        const n = ids.length ? lastSlideMention(part.text) : null;
        if (state && n && n <= ids.length) showSlide(part.sessionID, state, ids[n - 1]);
      }
      return;
    }

    if (event?.type !== "session_changed") return;
    const sessionId: string | undefined = event.sessionId;
    if (!sessionId) return;

    if (event.action === "deleted") {
      targetBySession.delete(sessionId);
      sawBusy.delete(sessionId);
      held.delete(sessionId);
      slideBySession.delete(sessionId);
      stop(sessionId);
      return;
    }

    const status: string | undefined = event.status;
    if (status === "busy") {
      sawBusy.add(sessionId);
      startIfReady(sessionId);
    } else if (status === "idle") {
      // (`retry` -- opencode backing off from a provider error before the
      // same run continues -- is deliberately not here: the run is paused,
      // not finished, and tearing the window down would blank the XR screen
      // for the backoff and remount it on resume.)
      // A held session (busy-interruption abort in flight) keeps its stream
      // regardless -- this idle is a pause, not completion.
      if (held.has(sessionId)) return;
      // Only tear down once we've actually seen the session run, so an initial
      // "idle" poll right after a drop doesn't kill the optimistic stream.
      if (sawBusy.has(sessionId)) {
        sawBusy.delete(sessionId);
        targetBySession.delete(sessionId);
        stop(sessionId);
      }
    }
  };

  spatialEventsBroker.addListener(listener);

  return {
    noteSessionDoc(sessionId, fileId) {
      if (!sessionId || !fileId) return;
      noteSessionUrl(sessionId, googleDocUrl(fileId));
    },
    noteSessionUrl,
    noteExtensionCall(body, callResult) {
      if (!body || typeof body !== "object") return;
      const b = body as Record<string, unknown>;
      if (asString(b.extensionId) !== "google-workspace") return;
      const context = b.context && typeof b.context === "object" ? (b.context as Record<string, unknown>) : {};
      const sessionId = asString(context.sessionId);
      if (!sessionId) return;
      const action = asString(b.action);
      const url = googleWorkspaceViewUrl(action, b.args, callResult);
      if (!url) return;
      // Keep the window on the slide it is already showing when the agent
      // merely reads the deck; an edit moves it below.
      const state = slideBySession.get(sessionId);
      const keep = state && stripSlideFragment(url) === stripSlideFragment(state.baseUrl) && state.current;
      noteSessionUrl(sessionId, keep ? slideUrl(state.baseUrl, state.current as string) : url);
      if (action.startsWith("slides_")) noteSlidesCall(sessionId, action, b.args, callResult, url);
    },
    noteSessionComputerUse(sessionId) {
      if (!sessionId) return;
      noteSessionTarget(sessionId, { kind: "screen" });
    },
    holdSessionOpen(sessionId) {
      if (sessionId) held.add(sessionId);
    },
    releaseHold(sessionId) {
      if (sessionId) held.delete(sessionId);
    },
    stopSession(sessionId) {
      if (!sessionId) return;
      held.delete(sessionId);
      sawBusy.delete(sessionId);
      targetBySession.delete(sessionId);
      slideBySession.delete(sessionId);
      stop(sessionId);
    },
    stepSlide(sessionId, delta) {
      const state = slideBySession.get(sessionId);
      const ids = state?.outline?.slideIds ?? [];
      if (!state || ids.length === 0) {
        // Nothing to page through yet; a deck the agent only created but
        // never read has no outline until the fetcher runs.
        if (state) refreshOutline(sessionId, state);
        return { ok: false };
      }
      const at = state.current ? ids.indexOf(state.current) : -1;
      const index = Math.min(ids.length - 1, Math.max(0, (at === -1 ? 0 : at) + Math.trunc(delta)));
      showSlide(sessionId, state, ids[index]);
      return { ok: true, index, count: ids.length };
    },
    setSlideOutlineFetcher(fetcher) {
      slideOutlineFetcher = fetcher;
    },
    dispose() {
      spatialEventsBroker.removeListener(listener);
    },
  };
}

// Process-wide singletons. The relay owns one (port-less) WebSocketServer; the
// coordinator owns one subscription to the shared `spatialEventsBroker`. Both
// are referenced from `startServer` (upgrade wiring) and the spatial route
// handlers, which live in a different lexical scope — hence module singletons,
// consistent with `spatialEventsBroker` itself.
export const spatialStreamRelay = createSpatialStreamRelay();
export const spatialStreamCoordinator = createSpatialStreamCoordinator(spatialStreamRelay);
spatialStreamRelay.setScreenControlHandler((sessionId, delta) => spatialStreamCoordinator.stepSlide(sessionId, delta));
