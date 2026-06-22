// Spatial stream capture controller (XR "virtual screens", sender side).
//
// Connects to the OpenWork server's WebSocket relay as the "capture
// controller". When the server-side coordinator asks for a session's window
// (startStream), we open a hidden BrowserWindow at the Doc URL, attach the
// in-process CDP debugger, and stream JPEG frames via Page.startScreencast to
// the relay. The XR client subscribes and renders them on the agent's avatar.
//
// Frame protocol (matches the relay + xrblocks virtual_screens receiver):
//   [uint8 streamIdLen][streamId][uint8 frameType][JPEG bytes]
// JSON-RPC control: { params: { target, func, args } } / replies { id, result }.
import { BrowserWindow } from "electron";
import { WebSocket } from "ws";

const STREAM_PATH = "/experimental/spatial/stream";
const RECONNECT_MS = 2000;
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
      void startStream(String(args[0] ?? ""), String(args[1] ?? ""));
    } else if (params.func === "stopStream") {
      stopStream(String(args[0] ?? ""));
    }
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

  async function startStream(sessionId, url) {
    if (!sessionId || !url || sessions.has(sessionId)) return;

    const win = new BrowserWindow({
      show: SHOW_CAPTURE,
      width: CAPTURE_WIDTH,
      height: CAPTURE_HEIGHT,
      ...(SHOW_CAPTURE ? {} : { x: -4000, y: -4000 }),
      skipTaskbar: !SHOW_CAPTURE,
      webPreferences: { backgroundThrottling: false, offscreen: false },
    });
    const entry = { win, dbg: null, started: false };
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

  function stopStream(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) return;
    sessions.delete(sessionId);
    rpc("streamManager", "stop_stream", [sessionId]);
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
    try {
      if (!entry.win.isDestroyed()) entry.win.destroy();
    } catch {
      /* ignore */
    }
    console.log(`[spatial-capture] stopped session ${sessionId}`);
  }

  return {
    start() {
      void connect();
    },
    stop() {
      disposed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
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
