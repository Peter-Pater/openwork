// Spatial stream capture controller (XR "virtual screens", sender side).
//
// Connects to the OpenWork server's WebSocket relay as the "capture
// controller". When the server-side coordinator asks for a session's stream
// (startStream with a target), we capture frames and relay JPEG to the server;
// the XR client subscribes and renders them on the agent's avatar.
//
// Two capture backends, chosen by target.kind:
//   - "browser": open a hidden BrowserWindow at a URL (GWS docs) and screencast
//     it via the in-process CDP debugger (Page.startScreencast).
//   - "screen":  capture the primary display for a computer-use session, via a
//     hidden renderer running desktopCapturer+getUserMedia → canvas → JPEG
//     (see spatial-capture-preload.cjs). CDP can't see the OS desktop, so this
//     path uses a renderer instead.
//
// Frame protocol (matches the relay + xrblocks virtual_screens receiver):
//   [uint8 streamIdLen][streamId][uint8 frameType][JPEG bytes]
// JSON-RPC control: { params: { target, func, args } } / replies { id, result }.
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow, desktopCapturer, ipcMain, screen as electronScreen, systemPreferences } from "electron";
import { WebSocket } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STREAM_PATH = "/experimental/spatial/stream";
const RECONNECT_MS = 2000;
const SCREEN_FPS = 12; // capture frame rate for computer-use screen streams
const SCREEN_MAX_WIDTH = 1280; // downscale the display to at most this width
// Capture windows are hidden + parked off-screen by default. Set
// OPENWORK_SPATIAL_SHOW_CAPTURE=1 to show them on-screen (debugging / a
// fallback if a platform throttles screencast for hidden windows).
const SHOW_CAPTURE = process.env.OPENWORK_SPATIAL_SHOW_CAPTURE === "1";
const CAPTURE_WIDTH = 1280;
const CAPTURE_HEIGHT = 800;
// macOS clamps every window so a minimum sliver stays on a display (so the user
// can always reach it), meaning no off-screen x/y can fully hide it. So on Mac
// we leave it on-screen but transparent (it still paints → screencast frames
// keep flowing); Windows honors the off-screen position and needs no opacity.
const IS_MAC = process.platform === "darwin";

export function createSpatialStreamCapture({ getServerUrl }) {
  let ws = null;
  let reconnectTimer = null;
  let disposed = false;
  const sessions = new Map(); // sessionId -> { win, dbg, started }

  async function resolveWsUrl() {
    let base = null;
    try {
      base = await getServerUrl?.();
    } catch {
      base = null;
    }
    if (!base) return null;
    try {
      const u = new URL(base);
      u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
      u.pathname = STREAM_PATH;
      u.search = "";
      u.hash = "";
      return u.toString();
    } catch {
      return null;
    }
  }

  function scheduleReconnect() {
    if (disposed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, RECONNECT_MS);
  }

  async function connect() {
    if (disposed) return;
    const url = await resolveWsUrl();
    if (!url) {
      scheduleReconnect();
      return;
    }
    let socket;
    try {
      socket = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }
    ws = socket;
    socket.on("open", () => {
      rpc("captureController", "register", []);
    });
    socket.on("message", (data, isBinary) => {
      if (!isBinary) handleText(data.toString());
    });
    socket.on("close", () => {
      if (ws === socket) ws = null;
      scheduleReconnect();
    });
    socket.on("error", () => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    });
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(obj));
      } catch {
        /* socket closing */
      }
    }
  }

  function rpc(target, func, args) {
    send({ params: { target, func, args } });
  }

  function handleText(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const params = msg?.params;
    if (!params || params.target !== "captureController") return;
    const args = Array.isArray(params.args) ? params.args : [];
    if (params.func === "startStream") {
      void startStream(String(args[0] ?? ""), normalizeTarget(args[1]));
    } else if (params.func === "updateStream") {
      void updateStream(String(args[0] ?? ""), String(args[1] ?? ""));
    } else if (params.func === "stopStream") {
      stopStream(String(args[0] ?? ""));
    }
  }

  // The relay forwards whatever target the coordinator sent. Accept both the
  // new `{ kind, url? }` object and a bare URL string (legacy/browser).
  function normalizeTarget(raw) {
    if (typeof raw === "string") return raw ? { kind: "browser", url: raw } : null;
    if (raw && typeof raw === "object" && typeof raw.kind === "string") {
      if (raw.kind === "browser") return raw.url ? { kind: "browser", url: String(raw.url) } : null;
      if (raw.kind === "screen") return { kind: "screen" };
    }
    return null;
  }

  function sendFrame(sessionId, jpeg) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const idBytes = Buffer.from(sessionId, "utf8");
    const header = Buffer.alloc(1 + idBytes.length + 1);
    header.writeUInt8(idBytes.length, 0);
    idBytes.copy(header, 1);
    header.writeUInt8(0, 1 + idBytes.length); // frameType 0: standalone JPEG.
    try {
      ws.send(Buffer.concat([header, jpeg]));
    } catch {
      /* dropped frame */
    }
  }

  // Dispatch a start request to the right capture backend. A startStream for an
  // already-active session means the target kind changed (same-kind updates come
  // via updateStream), so tear down the old capture first.
  async function startStream(sessionId, target) {
    if (!sessionId || !target) return;
    const existing = sessions.get(sessionId);
    if (existing) {
      if (existing.kind === target.kind && target.kind === "browser") return;
      stopStream(sessionId);
    }
    if (target.kind === "screen") {
      await startScreenStream(sessionId);
    } else if (target.kind === "browser") {
      await startBrowserStream(sessionId, target.url);
    }
  }

  async function startBrowserStream(sessionId, url) {
    if (!sessionId || !url || sessions.has(sessionId)) return;

    const win = new BrowserWindow({
      show: SHOW_CAPTURE,
      width: CAPTURE_WIDTH,
      height: CAPTURE_HEIGHT,
      ...(SHOW_CAPTURE ? {} : { x: -4000, y: -4000 }),
      skipTaskbar: !SHOW_CAPTURE,
      webPreferences: { backgroundThrottling: false, offscreen: false },
    });
    const entry = { win, kind: "browser", dbg: null, started: false };
    sessions.set(sessionId, entry);

    try {
      win.webContents.setBackgroundThrottling(false);
    } catch {
      /* ignore */
    }
    // Keep the renderer painting without stealing focus (hidden windows can
    // otherwise stop producing compositor frames).
    if (!SHOW_CAPTURE) {
      try {
        win.showInactive();
      } catch {
        /* ignore */
      }
      // On macOS the window can't be parked fully off-screen, so make the
      // unavoidable sliver invisible and click-through instead.
      if (IS_MAC) {
        try {
          win.setOpacity(0);
          win.setIgnoreMouseEvents(true);
        } catch {
          /* ignore */
        }
      }
    }

    win.webContents.loadURL(url).catch((e) => {
      console.warn(`[spatial-capture] loadURL failed for ${sessionId}:`, e?.message ?? e);
    });

    const dbg = win.webContents.debugger;
    try {
      dbg.attach("1.3");
    } catch (e) {
      console.warn(`[spatial-capture] debugger.attach failed for ${sessionId}:`, e?.message ?? e);
      stopStream(sessionId);
      return;
    }
    entry.dbg = dbg;

    dbg.on("message", (_event, method, params) => {
      if (method !== "Page.screencastFrame") return;
      let jpeg;
      try {
        jpeg = Buffer.from(params.data, "base64");
      } catch {
        return;
      }
      if (!entry.started) {
        entry.started = true;
        const width = Math.round(params.metadata?.deviceWidth || CAPTURE_WIDTH);
        const height = Math.round(params.metadata?.deviceHeight || CAPTURE_HEIGHT);
        rpc("streamManager", "start_stream", [sessionId, { width, height }]);
      }
      sendFrame(sessionId, jpeg);
      dbg.sendCommand("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
    });

    try {
      await dbg.sendCommand("Page.enable");
      await dbg.sendCommand("Page.startScreencast", {
        format: "jpeg",
        quality: 60,
        maxWidth: CAPTURE_WIDTH,
        maxHeight: CAPTURE_HEIGHT,
        everyNthFrame: 1,
      });
      console.log(`[spatial-capture] streaming session ${sessionId} → ${url}`);
    } catch (e) {
      console.warn(`[spatial-capture] startScreencast failed for ${sessionId}:`, e?.message ?? e);
    }
  }

  // Computer-use screen capture. CDP can't see the OS desktop, so we drive a
  // hidden renderer (spatial-capture-preload.cjs) that grabs the primary display
  // via desktopCapturer+getUserMedia and posts JPEG frames back over IPC.
  async function startScreenStream(sessionId) {
    if (IS_MAC && systemPreferences.getMediaAccessStatus?.("screen") !== "granted") {
      console.warn(
        "[spatial-capture] Screen Recording permission not granted to OpenWork — the screen stream may be blank. " +
          "Grant it in System Settings → Privacy & Security → Screen Recording.",
      );
    }
    try {
      const primary = electronScreen.getPrimaryDisplay();
      const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find((s) => String(s.display_id) === String(primary.id)) ?? sources[0] ?? null;
      if (!source) {
        console.warn(`[spatial-capture] no screen source available for ${sessionId}`);
        return;
      }
      const { width: dw, height: dh } = primary.size ?? { width: 0, height: 0 };
      const maxWidth = Math.min(dw || SCREEN_MAX_WIDTH, SCREEN_MAX_WIDTH);
      const maxHeight = dw ? Math.round(maxWidth * (dh / dw)) : 800;

      const win = new BrowserWindow({
        show: false,
        width: 320,
        height: 240,
        skipTaskbar: true,
        webPreferences: {
          preload: path.join(__dirname, "spatial-capture-preload.cjs"),
          sandbox: false,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
          offscreen: false,
        },
      });
      const entry = { win, kind: "screen", dbg: null, started: false };
      sessions.set(sessionId, entry);

      // Wait for the renderer (and its preload) before asking it to capture.
      await win.webContents.loadURL("about:blank");
      if (win.isDestroyed()) return; // stopped while loading
      win.webContents.send("spatial-capture-start", {
        sessionId,
        sourceId: source.id,
        fps: SCREEN_FPS,
        maxWidth,
        maxHeight,
        quality: 0.6,
      });
      console.log(`[spatial-capture] streaming screen for session ${sessionId} (${maxWidth}x${maxHeight})`);
    } catch (e) {
      console.warn(`[spatial-capture] startScreenStream failed for ${sessionId}:`, e?.message ?? e);
      stopStream(sessionId);
    }
  }

  // JPEG frames posted by the screen-capture renderer over IPC.
  function onScreenFrame(_event, payload) {
    if (!payload) return;
    const sessionId = String(payload.sessionId ?? "");
    const entry = sessions.get(sessionId);
    if (!entry || entry.kind !== "screen" || !payload.data) return;
    if (!entry.started) {
      entry.started = true;
      const width = Math.round(payload.width || SCREEN_MAX_WIDTH);
      const height = Math.round(payload.height || 800);
      rpc("streamManager", "start_stream", [sessionId, { width, height }]);
      console.log(`[spatial-capture] first screen frame for session ${sessionId} (${width}x${height})`);
    }
    sendFrame(sessionId, Buffer.from(payload.data));
  }

  // Surface getUserMedia / permission failures from the hidden capture renderer
  // (otherwise they'd be invisible — the renderer has no devtools open).
  function onScreenError(_event, payload) {
    console.warn(
      `[spatial-capture] screen-capture renderer error for session ${payload?.sessionId ?? "?"}: ${payload?.error ?? "unknown"}`,
    );
  }

  // Re-point an already-open capture window at a new URL (agent switched docs).
  // The screencast keeps running on the same webContents, so the XR panel stays
  // mounted and just shows the new page — no stream restart, no panel flicker.
  async function updateStream(sessionId, url) {
    if (!url) return;
    const entry = sessions.get(sessionId);
    if (!entry) {
      void startStream(sessionId, { kind: "browser", url });
      return;
    }
    if (entry.kind !== "browser") return; // screen streams have no URL to re-point
    try {
      await entry.win.webContents.loadURL(url);
      console.log(`[spatial-capture] re-pointed session ${sessionId} → ${url}`);
    } catch (e) {
      console.warn(`[spatial-capture] updateStream loadURL failed for ${sessionId}:`, e?.message ?? e);
    }
  }

  function stopStream(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) return;
    sessions.delete(sessionId);
    rpc("streamManager", "stop_stream", [sessionId]);
    if (entry.kind === "browser") {
      try {
        entry.dbg?.sendCommand("Page.stopScreencast").catch(() => {});
      } catch {
        /* ignore */
      }
      try {
        if (entry.dbg?.isAttached()) entry.dbg.detach();
      } catch {
        /* ignore */
      }
    } else if (entry.kind === "screen") {
      try {
        if (!entry.win.isDestroyed()) entry.win.webContents.send("spatial-capture-stop");
      } catch {
        /* ignore */
      }
    }
    try {
      if (!entry.win.isDestroyed()) entry.win.destroy();
    } catch {
      /* ignore */
    }
    console.log(`[spatial-capture] stopped session ${sessionId}`);
  }

  return {
    start() {
      ipcMain.on("spatial-capture-frame", onScreenFrame);
      ipcMain.on("spatial-capture-error", onScreenError);
      void connect();
    },
    stop() {
      disposed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      ipcMain.removeListener("spatial-capture-frame", onScreenFrame);
      ipcMain.removeListener("spatial-capture-error", onScreenError);
      for (const id of [...sessions.keys()]) stopStream(id);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      ws = null;
    },
  };
}
