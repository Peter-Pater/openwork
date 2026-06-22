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
  /** Ask the connected capture controller(s) to open + stream a window. */
  requestStartStream(streamId: string, url: string): void;
  /** Ask the connected capture controller(s) to re-point an open window's URL. */
  requestUpdateStream(streamId: string, url: string): void;
  /** Ask the connected capture controller(s) to stop + close a window. */
  requestStopStream(streamId: string): void;
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
    requestStartStream(streamId, url) {
      for (const controller of controllers) {
        call(controller, "captureController", "startStream", [streamId, url]);
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
  dispose(): void;
};

function googleDocUrl(fileId: string): string {
  return `https://docs.google.com/document/d/${encodeURIComponent(fileId)}/edit`;
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
 * Subscribes to `spatialEventsBroker` and maps session lifecycle → stream
 * lifecycle. A stream is only ever started for a session we know is working on a
 * viewable artifact (a Doc), so no-artifact tasks never open a window.
 */
export function createSpatialStreamCoordinator(relay: SpatialStreamRelay): SpatialStreamCoordinator {
  const urlBySession = new Map<string, string>(); // sessionId -> current view URL
  const streaming = new Set<string>(); // sessionIds with a live stream request
  const sawBusy = new Set<string>(); // sessionIds observed busy since last note

  function startIfReady(sessionId: string): void {
    const url = urlBySession.get(sessionId);
    if (!url || streaming.has(sessionId)) return;
    streaming.add(sessionId);
    relay.requestStartStream(sessionId, url);
  }

  function noteSessionUrl(sessionId: string, url: string): void {
    if (!sessionId || !url) return;
    const previous = urlBySession.get(sessionId);
    urlBySession.set(sessionId, url);
    if (streaming.has(sessionId)) {
      // Doc switch mid-session: re-point the open window, keep the same panel.
      if (previous !== url) relay.requestUpdateStream(sessionId, url);
    } else {
      startIfReady(sessionId); // optimistic head start (don't wait for "busy")
    }
  }

  function stop(sessionId: string): void {
    if (!streaming.has(sessionId)) return;
    streaming.delete(sessionId);
    relay.requestStopStream(sessionId);
  }

  const listener = (event: any) => {
    if (event?.type !== "session_changed") return;
    const sessionId: string | undefined = event.sessionId;
    if (!sessionId) return;

    if (event.action === "deleted") {
      urlBySession.delete(sessionId);
      sawBusy.delete(sessionId);
      stop(sessionId);
      return;
    }

    const status: string | undefined = event.status;
    if (status === "busy") {
      sawBusy.add(sessionId);
      startIfReady(sessionId);
    } else if (status === "idle" || status === "retry") {
      // Only tear down once we've actually seen the session run, so an initial
      // "idle" poll right after a drop doesn't kill the optimistic stream.
      if (sawBusy.has(sessionId)) {
        sawBusy.delete(sessionId);
        urlBySession.delete(sessionId);
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
      const url = googleWorkspaceViewUrl(asString(b.action), b.args, callResult);
      if (url) noteSessionUrl(sessionId, url);
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
