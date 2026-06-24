// Screen-capture renderer for XR "virtual screens" (computer-use sessions).
//
// CDP can only screencast BrowserWindows we create — it can't see the OS
// desktop. So for computer-use sessions the capture controller (main process)
// opens a hidden window with THIS preload, which captures the primary display
// via desktopCapturer+getUserMedia, draws frames to a canvas, and posts JPEG
// bytes back to main over IPC. Main prepends the wire header and relays them,
// so the rest of the pipeline (relay → XR receiver → panel) is unchanged.
//
// Runs in the renderer (has `navigator.mediaDevices`); `sandbox:false` lets the
// preload require electron's ipcRenderer.
const { ipcRenderer } = require("electron");

let timer = null;
let stream = null;
let video = null;
let canvas = null;
let ctx = null;

function stopCapture() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (stream) {
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        /* ignore */
      }
    }
    stream = null;
  }
  video = null;
  canvas = null;
  ctx = null;
}

async function startCapture({ sessionId, fps, maxWidth, maxHeight, quality }) {
  stopCapture();
  const frameRate = Math.max(1, Math.min(Number(fps) || 12, 30));
  const w = Math.max(160, Math.round(Number(maxWidth) || 1280));
  const h = Math.max(120, Math.round(Number(maxHeight) || 800));
  const jpegQuality = Math.min(Math.max(Number(quality) || 0.6, 0.1), 0.95);

  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      throw new Error("navigator.mediaDevices.getDisplayMedia unavailable");
    }
    // Main has installed a display-media request handler that supplies the
    // primary display (no picker) and grants the request, so this resolves
    // directly to the screen's MediaStream.
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate }, audio: false });
  } catch (e) {
    ipcRenderer.send("spatial-capture-error", { sessionId, error: String(e && e.message ? e.message : e) });
    return;
  }

  video = document.createElement("video");
  video.muted = true;
  video.srcObject = stream;
  try {
    await video.play();
  } catch {
    /* autoplay of a muted element should be allowed; ignore */
  }

  canvas = document.createElement("canvas");
  ctx = canvas.getContext("2d", { alpha: false });

  timer = setInterval(() => {
    if (!video || !ctx) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return; // first frames not decoded yet
    // Fit the display into the capped size, preserving aspect ratio.
    const scale = Math.min(w / vw, h / vh, 1);
    const dw = Math.max(1, Math.round(vw * scale));
    const dh = Math.max(1, Math.round(vh * scale));
    if (canvas.width !== dw || canvas.height !== dh) {
      canvas.width = dw;
      canvas.height = dh;
    }
    ctx.drawImage(video, 0, 0, dw, dh);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        blob
          .arrayBuffer()
          .then((buf) => {
            ipcRenderer.send("spatial-capture-frame", {
              sessionId,
              width: dw,
              height: dh,
              data: new Uint8Array(buf),
            });
          })
          .catch(() => {});
      },
      "image/jpeg",
      jpegQuality,
    );
  }, Math.round(1000 / frameRate));
}

ipcRenderer.on("spatial-capture-start", (_event, opts) => {
  void startCapture(opts || {});
});
ipcRenderer.on("spatial-capture-stop", () => {
  stopCapture();
});
