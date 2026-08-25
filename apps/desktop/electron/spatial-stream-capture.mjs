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

import { BrowserWindow, desktopCapturer, ipcMain, screen as electronScreen, shell, systemPreferences } from "electron";
import { WebSocket } from "ws";

import { createArtifactCapture } from "./artifact-capture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STREAM_PATH = "/experimental/spatial/stream";
const RECONNECT_MS = 2000;
const SCREEN_FPS = 12; // capture frame rate for computer-use screen streams
const SCREEN_MAX_WIDTH = 1280; // downscale the display to at most this width
// Frame rate cap for browser (CDP screencast) streams. CDP emits a frame per
// compositor paint, which over loopback is free but saturates the link to a
// headset over Wi-Fi / adb / a tunnel. Matches the screen backend's cap by
// default; override with OPENWORK_SPATIAL_BROWSER_FPS (0 = uncapped).
const BROWSER_FPS = (() => {
  const raw = Number(process.env.OPENWORK_SPATIAL_BROWSER_FPS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 12;
})();
const BROWSER_MIN_FRAME_MS = BROWSER_FPS > 0 ? 1000 / BROWSER_FPS : 0;
// Isolated in-memory session for the capture windows, so the permission +
// display-media handlers we install don't touch the app's other sessions.
const SCREEN_PARTITION = "spatial-screen-capture";

function openScreenRecordingSettings() {
  if (process.platform !== "darwin") return;
  try {
    void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
  } catch {
    /* ignore */
  }
}
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
  // Artifact-pile captures ride this module's relay socket rather than
  // opening a second one -- the server addresses both jobs at the same
  // captureController target (see spatial-stream-relay.ts).
  const artifactCapture = createArtifactCapture();
  let screenSettingsOpened = false; // open the macOS settings pane at most once
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
      // The relay ends every stream a dropped socket was sending, so the XR
      // panels are gone; the captures here are still running. Re-announce
      // them so the receivers pick the streams straight back up.
      for (const [sessionId, entry] of sessions) {
        if (!entry.info) continue;
        rpc("streamManager", "start_stream", [sessionId, entry.info]);
        console.log(`[spatial-capture] re-announced session ${sessionId} after reconnect`);
      }
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
    } else if (params.func === "captureArtifact") {
      // Fire-and-forget in: the server->controller direction carries no RPC
      // ids, so the result returns as a call the other way (artifactStore.
      // ingest), correlated by requestId. capture() never rejects.
      //
      // The ingest is sent directly rather than through send()/rpc(), whose
      // silent catch is fine for a dropped video frame but turned a lost
      // artifact into an undiagnosable hole: capture completed (the hidden
      // window's history proved it) while nothing arrived server-side and
      // nothing said why. Every outcome here logs.
      const requestId = String(args[0] ?? "");
      const url = String(args[1] ?? "");
      const options = args[2] && typeof args[2] === "object" ? args[2] : {};
      if (requestId) {
        console.log(`[artifact-capture] ${requestId}: capturing ${url}${options.imageOnly ? " (image-only)" : ""}`);
        void artifactCapture.capture(url, options).then((payload) => {
          const chars = payload?.base64?.length ?? 0;
          if (!ws || ws.readyState !== WebSocket.OPEN) {
            console.warn(`[artifact-capture] ${requestId}: relay socket not open (state ${ws?.readyState}); ingest dropped.`);
            return;
          }
          try {
            ws.send(JSON.stringify({ params: { target: "artifactStore", func: "ingest", args: [requestId, payload] } }));
            console.log(
              `[artifact-capture] ${requestId}: ingest sent (ok=${payload?.ok}, kind=${payload?.kind ?? "-"}, ` +
              `${chars} base64 chars${payload?.error ? `, error: ${payload.error}` : ""}).`,
            );
          } catch (e) {
            console.warn(`[artifact-capture] ${requestId}: ingest send failed:`, e?.message ?? e);
          }
        });
      }
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
    const entry = { win, kind: "browser", dbg: null, started: false, lastSentMs: 0 };
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
        entry.info = { width, height };
        rpc("streamManager", "start_stream", [sessionId, { width, height }]);
      }
      // Drop frames above the cap, but always ack -- CDP stalls the screencast
      // until the previous frame is acknowledged.
      const now = Date.now();
      if (!BROWSER_MIN_FRAME_MS || now - entry.lastSentMs >= BROWSER_MIN_FRAME_MS) {
        entry.lastSentMs = now;
        sendFrame(sessionId, jpeg);
      }
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
    if (IS_MAC) {
      const status = systemPreferences.getMediaAccessStatus?.("screen");
      if (status && status !== "granted") {
        console.warn(`[spatial-capture] macOS screen-recording status: ${status} — capture may be blank until granted.`);
      }
    }
    try {
      const primary = electronScreen.getPrimaryDisplay();
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
          // This is our own hidden, content-free page; contextIsolation:false
          // lets the preload use the page's main-world navigator.mediaDevices.
          contextIsolation: false,
          nodeIntegration: false,
          backgroundThrottling: false,
          offscreen: false,
          partition: SCREEN_PARTITION,
        },
      });
      const entry = { win, kind: "screen", dbg: null, started: false };
      sessions.set(sessionId, entry);

      // Use Electron's supported screen-capture flow: getDisplayMedia in the
      // renderer, with main supplying the primary display (no picker) and
      // granting the request. This both authorizes the capture at the Chromium
      // layer and engages the macOS Screen Recording permission properly.
      const ses = win.webContents.session;
      ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(true));
      ses.setDisplayMediaRequestHandler(
        async (_request, callback) => {
          try {
            const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
            const source = sources.find((s) => String(s.display_id) === String(primary.id)) ?? sources[0] ?? null;
            callback(source ? { video: source } : undefined);
          } catch (e) {
            console.warn(`[spatial-capture] getSources failed for ${sessionId}:`, e?.message ?? e);
            callback();
          }
        },
        { useSystemPicker: false },
      );

      // Load over file:// (a secure context — required for getDisplayMedia to be
      // exposed) and wait for the preload before asking it to capture.
      await win.webContents.loadFile(path.join(__dirname, "spatial-capture.html"));
      if (win.isDestroyed()) return; // stopped while loading
      win.webContents.send("spatial-capture-start", {
        sessionId,
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
      entry.info = { width, height };
      rpc("streamManager", "start_stream", [sessionId, { width, height }]);
      console.log(`[spatial-capture] first screen frame for session ${sessionId} (${width}x${height})`);
    }
    sendFrame(sessionId, Buffer.from(payload.data));
  }

  // Surface getDisplayMedia / permission failures from the hidden capture
  // renderer (otherwise they'd be invisible — the renderer has no devtools).
  function onScreenError(_event, payload) {
    const error = String(payload?.error ?? "unknown");
    console.warn(`[spatial-capture] screen-capture renderer error for session ${payload?.sessionId ?? "?"}: ${error}`);
    // A permission denial on macOS has no interactive prompt — jump the user to
    // the Screen Recording settings pane so they can grant it (once per run).
    if (IS_MAC && /denied|not.?allowed|permission/i.test(error) && !screenSettingsOpened) {
      screenSettingsOpened = true;
      console.warn(
        "[spatial-capture] Opening Screen Recording settings — enable OpenWork (dev: 'Electron'), then fully quit and relaunch.",
      );
      openScreenRecordingSettings();
    }
  }

  // Same document ignoring the fragment and the `slide` query param the Slides
  // editor mirrors its current page into (`/edit?slide=id.X#slide=id.X`).
  function samePage(a, b) {
    const norm = (raw) => {
      try {
        const u = new URL(raw);
        u.hash = "";
        u.searchParams.delete("slide");
        return u.toString();
      } catch {
        return raw.split("#")[0];
      }
    };
    return norm(a) === norm(b);
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
      const contents = entry.win.webContents;
      // Same page, different fragment: Google Slides routes the shown slide
      // through `#slide=id.X` and reacts to a hash change in place, so set
      // the hash instead of reloading (a loadURL would flash the editor).
      const hashAt = url.indexOf("#");
      if (hashAt !== -1 && samePage(contents.getURL(), url)) {
        await contents.executeJavaScript(`location.hash = ${JSON.stringify(url.slice(hashAt + 1))}; undefined`, true);
        console.log(`[spatial-capture] moved session ${sessionId} → ${url.slice(hashAt)}`);
        return;
      }
      await contents.loadURL(url);
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
      artifactCapture.dispose();
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
