// Artifact capture engine (XR "intermediate artifact piles", capture side).
//
// The server's artifact watcher observes agents' webfetch calls and asks this
// module -- over the same relay socket spatial-stream-capture.mjs already
// holds -- to fetch a URL and decide what it is:
//
//   image  -> return the bytes                        (left pile beside the avatar)
//   page   -> render it and return a PNG screenshot   (right pile)
//
// Both operations run on the app's in-app-browser partition
// (`persist:openwork-browser`, see browser-panel.mjs) so authenticated pages
// -- Google Docs, intranet dashboards -- render as the USER sees them, not as
// a sign-in wall. This is a deliberate divergence from the doc-streaming
// capture window, which uses the default session: do not "unify" them.
//
// Routing is by MAGIC BYTES, never the Content-Type header. A browser renders
// a bare .jpg as an HTML document (the image centred on a dark page), so a
// misrouted image would land in the page pile as a screenshot of the very
// image the left pile already holds -- the exact duplication failure the
// sniff exists to prevent. Anything that sniffs as an image must never reach
// the renderer. (The server re-verifies the sniff before storing; this copy
// exists because the routing decision has to happen where the bytes are.)
import { BrowserWindow, nativeImage, session } from "electron";

const PARTITION = "persist:openwork-browser";
const CAPTURE_WIDTH = 1280;
const CAPTURE_HEIGHT = 800;
// Matches the server's screenshot cap (10MB data URLs on the prompt route).
// This caps what gets SENT/STORED, not what gets downloaded -- see below.
const MAX_BYTES = 10 * 1024 * 1024;
// Downloads may run larger, because oversized images are DOWNSCALED rather
// than rejected: Wikimedia Commons originals are routinely 10-40MB, and the
// first real user test lost one of three slide images to a hard 10MB reject.
// The pile is a visual record, not an archive -- a 1600px JPEG serves it
// better than the original ever would.
const MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024;
// Images above this get decoded and re-encoded even if under MAX_BYTES,
// keeping the store lean; below it, original bytes are kept verbatim.
const RESIZE_THRESHOLD_BYTES = 2 * 1024 * 1024;
const RESIZE_MAX_DIMENSION = 1600;
const RESIZE_JPEG_QUALITY = 85;
// Covers the whole fetch including the body read; sized for a full-resolution
// Commons original (up to MAX_DOWNLOAD_BYTES) on a modest connection, while
// still fitting inside the watcher's 60s round-trip timeout.
const FETCH_TIMEOUT_MS = 45_000;
// did-finish-load never fires on some pages; skip and move on rather than wedge.
const LOAD_TIMEOUT_MS = 15_000;
// Late layout/lazy images settle after load; a snapshot taken at the event is
// routinely half-painted.
const SETTLE_MS = 1_200;
// A research prompt can burst several fetches; beyond this, fail fast instead
// of queueing past the watcher's own 60s round-trip timeout.
const MAX_QUEUE = 4;

/**
 * Magic-byte sniff -- keep in sync with sniffImage in
 * apps/server/src/environments/artifacts/session-artifact-store.ts, which is
 * the tested authority. SVG is deliberately text (a document, not an image).
 */
function sniffImage(bytes) {
  if (bytes.length < 12) return null;
  const ascii = (start, len) => String.fromCharCode(...bytes.subarray(start, start + len));
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  if (ascii(4, 4) === "ftyp" && (ascii(8, 4) === "avif" || ascii(8, 4) === "avis")) return "image/avif";
  return null;
}

export function createArtifactCapture() {
  let win = null; // one hidden window, reused; snapshots serialize through the queue
  let queue = Promise.resolve();
  let queueDepth = 0;
  let disposed = false;

  function ensureWindow() {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      show: false,
      width: CAPTURE_WIDTH,
      height: CAPTURE_HEIGHT,
      x: -4000,
      y: -4000,
      skipTaskbar: true,
      webPreferences: {
        partition: PARTITION,
        backgroundThrottling: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    // Keep the renderer painting without stealing focus (hidden windows can
    // otherwise stop producing compositor frames) -- same recipe as
    // spatial-stream-capture.mjs, including the macOS can't-park-offscreen
    // fallback.
    try {
      win.webContents.setBackgroundThrottling(false);
      win.showInactive();
      if (process.platform === "darwin") {
        win.setOpacity(0);
        win.setIgnoreMouseEvents(true);
      }
    } catch {
      /* cosmetic; capture still works */
    }
    return win;
  }

  /**
   * Fetch the URL and sniff it. Resolves to a payload for an image, or null
   * meaning "not an image -- render it". Reads incrementally so a non-image
   * is recognized from its first bytes and the download abandoned; the
   * renderer re-fetches it anyway.
   */
  async function fetchAsImage(url) {
    const ses = session.fromPartition(PARTITION);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await ses.fetch(url, {
        headers: { Accept: "*/*" },
        redirect: "follow",
        signal: controller.signal,
      });
      if (!res.body) return null;
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      let mime = undefined; // undefined = not yet sniffable
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
        if (mime === undefined && total >= 12) {
          const head = Buffer.concat(chunks.map((c) => Buffer.from(c)), Math.min(total, 32));
          mime = sniffImage(head);
          if (mime === null) {
            // A page. Stop downloading it here -- the renderer will load it.
            await reader.cancel().catch(() => {});
            return null;
          }
        }
        if (total > MAX_DOWNLOAD_BYTES) {
          await reader.cancel().catch(() => {});
          throw new Error(`image exceeds ${MAX_DOWNLOAD_BYTES} download bytes`);
        }
      }
      if (!mime) return null; // too short to sniff -> let the renderer try
      let bytes = Buffer.concat(chunks.map((c) => Buffer.from(c)), total);
      let width = null;
      let height = null;

      // Decode for dimensions, and downscale anything heavyweight.
      // nativeImage decodes PNG and JPEG only; GIF/WEBP/AVIF come back empty
      // and keep their original bytes (they must then fit MAX_BYTES or be
      // dropped -- rare enough not to build a decoder for).
      const decoded = nativeImage.createFromBuffer(bytes);
      if (!decoded.isEmpty()) {
        const size = decoded.getSize();
        width = size.width || null;
        height = size.height || null;
        if (bytes.length > RESIZE_THRESHOLD_BYTES) {
          const scale = Math.min(1, RESIZE_MAX_DIMENSION / Math.max(size.width, size.height));
          const resized = scale < 1 ? decoded.resize({ width: Math.round(size.width * scale) }) : decoded;
          // JPEG re-encode: these are photos in practice, and a flattened
          // background on the odd oversized transparent PNG is a fair trade
          // for never rejecting a pile item over file size again.
          const jpeg = resized.toJPEG(RESIZE_JPEG_QUALITY);
          if (jpeg.length > 0 && jpeg.length < bytes.length) {
            bytes = jpeg;
            const resizedSize = resized.getSize();
            width = resizedSize.width || width;
            height = resizedSize.height || height;
          }
        }
      }
      if (bytes.length > MAX_BYTES) throw new Error(`image exceeds ${MAX_BYTES} bytes after processing`);
      return {
        ok: true,
        kind: "image",
        base64: bytes.toString("base64"),
        finalUrl: res.url || url,
        title: null,
        width,
        height,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Render the URL in the hidden window and screenshot it. */
  async function snapshotPage(url) {
    const target = ensureWindow();
    const contents = target.webContents;

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        contents.removeListener("did-finish-load", onLoad);
        contents.removeListener("did-fail-load", onFail);
        err ? reject(err) : resolve();
      };
      const timer = setTimeout(() => finish(new Error("page load timed out")), LOAD_TIMEOUT_MS);
      const onLoad = () => finish();
      const onFail = (_event, code, description, failedUrl, isMainFrame) => {
        // Subframe failures (ads, trackers) are routine; only the main frame
        // failing means there is nothing to screenshot. -3 is Chromium's
        // ERR_ABORTED, fired spuriously by in-page redirects.
        if (isMainFrame && code !== -3) finish(new Error(`load failed (${code}): ${description}`));
      };
      contents.on("did-finish-load", onLoad);
      contents.on("did-fail-load", onFail);
      contents.loadURL(url).catch(() => {
        /* surfaced through did-fail-load */
      });
    });

    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    const image = await contents.capturePage();
    const png = image.toPNG();
    if (png.length > MAX_BYTES) throw new Error("snapshot exceeds size cap");
    const size = image.getSize();
    const payload = {
      ok: true,
      kind: "page",
      base64: png.toString("base64"),
      finalUrl: contents.getURL() || url,
      title: contents.getTitle() || null,
      width: size.width || null,
      height: size.height || null,
    };
    // Park the window so an authenticated page doesn't keep running (and
    // polling, and playing media) between captures.
    contents.loadURL("about:blank").catch(() => {});
    return payload;
  }

  return {
    /**
     * @param {string} url http(s) URL observed from a tool part.
     * @param {{imageOnly?: boolean}} [options] imageOnly requests come from
     *   URLs found inside extension-call inputs: only bytes that sniff as an
     *   image are wanted, and a non-image must NOT be rendered/snapshotted --
     *   both because most such URLs are API endpoints and document links the
     *   page pile must not collect, and because skipping the render is what
     *   keeps a burst of extension URLs from stampeding the snapshot queue.
     * @returns {Promise<object>} an ingest payload; never rejects.
     */
    async capture(url, options = {}) {
      const imageOnly = options?.imageOnly === true;
      if (disposed) return { ok: false, error: "capture disposed" };
      if (!/^https?:\/\//i.test(String(url ?? ""))) return { ok: false, error: "unsupported url" };
      try {
        const image = await fetchAsImage(url);
        if (image) return image;
      } catch (e) {
        // Fetch failed outright (site blocks non-navigation requests, TLS
        // quirk, size cap). There is no image payload either way, so the
        // page pile is the honest fallback -- the window's navigation is a
        // full browser load and often succeeds where a bare fetch does not.
        console.warn(`[artifact-capture] fetch failed for ${url}: ${e?.message ?? e}`);
      }
      if (imageOnly) return { ok: false, error: "not an image" };
      if (queueDepth >= MAX_QUEUE) return { ok: false, error: "snapshot queue full" };
      queueDepth++;
      const run = queue.then(() =>
        disposed ? { ok: false, error: "capture disposed" } : snapshotPage(url),
      );
      // The queue must survive a failed snapshot; each caller still sees its
      // own error.
      queue = run.then(
        () => {},
        () => {},
      );
      try {
        return await run;
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e) };
      } finally {
        queueDepth--;
      }
    },

    dispose() {
      disposed = true;
      if (win && !win.isDestroyed()) {
        try {
          win.destroy();
        } catch {
          /* ignore */
        }
      }
      win = null;
    },
  };
}
