import { test, expect } from "bun:test";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocket } from "ws";

import {
  createSpatialStreamRelay,
  createSpatialStreamCoordinator,
  googleWorkspaceViewUrl,
  lastSlideMention,
  slideOutlineFromPresentation,
  slideTargetFromCall,
  type SpatialStreamRelay,
} from "./spatial-stream-relay.js";
import { spatialEventsBroker } from "./events.js";
import { serve } from "./serve-node.js";

function makeFrame(streamId: string, payload: Uint8Array, frameType = 0): Buffer {
  const idBytes = Buffer.from(streamId, "utf8");
  const buf = Buffer.alloc(1 + idBytes.length + 1 + payload.length);
  let offset = 0;
  buf.writeUInt8(idBytes.length, offset);
  offset += 1;
  idBytes.copy(buf, offset);
  offset += idBytes.length;
  buf.writeUInt8(frameType, offset);
  offset += 1;
  Buffer.from(payload).copy(buf, offset);
  return buf;
}

/** Resolve with the next JSON (text) message matching `predicate`. */
function nextJson(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 2000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("timeout waiting for json message"));
    }, timeoutMs);
    function onMessage(data: any, isBinary: boolean) {
      if (isBinary) return;
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(msg);
      }
    }
    ws.on("message", onMessage);
  });
}

function nextBinary(ws: WebSocket, timeoutMs = 2000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("timeout waiting for binary message"));
    }, timeoutMs);
    function onMessage(data: any, isBinary: boolean) {
      if (!isBinary) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(data as Buffer);
    }
    ws.on("message", onMessage);
  });
}

function open(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function rpc(ws: WebSocket, target: string, func: string, args: unknown[] = []): Promise<any> {
  const id = `${Date.now()}-${Math.random()}`;
  const wait = nextJson(ws, (m) => m.id === id);
  ws.send(JSON.stringify({ id, params: { target, func, args } }));
  return wait;
}

async function withRelay(run: (port: number, relay: ReturnType<typeof createSpatialStreamRelay>) => Promise<void>) {
  const relay = createSpatialStreamRelay();
  const server = createServer();
  server.on("upgrade", (req, socket, head) => {
    if (!relay.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run(port, relay);
  } finally {
    relay.close();
    // Force lingering upgraded sockets shut; otherwise server.close() never
    // calls back. Also cap the wait so teardown can't hang the test runner.
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      setTimeout(resolve, 500);
    });
  }
}

test("relay forwards frames from sender to subscribed receiver and ends on disconnect", async () => {
  await withRelay(async (port, relay) => {
    const url = `ws://127.0.0.1:${port}/experimental/spatial/stream`;

    // Controller doubles as the stream sender.
    const sender = new WebSocket(url);
    await open(sender);
    await rpc(sender, "captureController", "register");
    expect(relay.hasController()).toBe(true);

    const receiver = new WebSocket(url);
    await open(receiver);

    // Sender registers a stream.
    await rpc(sender, "streamManager", "start_stream", ["s1", { width: 320, height: 240 }]);

    // Receiver discovers it.
    const active = await rpc(receiver, "streamManager", "get_active_streams");
    expect(active.result).toHaveProperty("s1");
    expect(active.result.s1).toEqual({ width: 320, height: 240 });

    // Subscribing triggers a keyframe request to the sender.
    const keyframe = nextJson(sender, (m) => m.params?.func === "triggerKeyFrame");
    await rpc(receiver, "streamManager", "subscribe_to_stream", ["s1"]);
    const kf = await keyframe;
    expect(kf.params.args[0]).toBe("s1");

    // A binary frame from the sender reaches the receiver byte-for-byte.
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const frame = makeFrame("s1", payload, 0);
    const received = nextBinary(receiver);
    sender.send(frame);
    const got = await received;
    expect(Buffer.compare(got, frame)).toBe(0);

    // Sender disconnect → receiver is told the stream ended.
    const ended = nextJson(receiver, (m) => m.params?.func === "onStreamEnded");
    sender.close();
    const endMsg = await ended;
    expect(endMsg.params.args[0]).toBe("s1");

    receiver.close();
  });
});

test("serve-node stop() resolves even with a live WebSocket (no restart hang)", async () => {
  // Regression guard: persistent upgraded (WebSocket) connections from the
  // relay must not be able to wedge a server restart. serve-node's stop() caps
  // the wait, so it always resolves even if the OS/runtime won't let close()
  // fire its callback while an upgraded socket lingers.
  const relay = createSpatialStreamRelay();
  const result = await serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("ok"),
    upgrade: (req, socket, head) => {
      if (!relay.handleUpgrade(req, socket, head)) socket.destroy();
    },
  });

  // A persistent client (like the Electron capture controller) stays connected.
  const client = new WebSocket(`ws://127.0.0.1:${result.port}/experimental/spatial/stream`);
  await open(client);
  await rpc(client, "captureController", "register");

  relay.disconnectClients();
  const start = Date.now();
  await result.stop();
  expect(Date.now() - start).toBeLessThan(2500);

  relay.close();
  try {
    client.terminate();
  } catch {
    /* ignore */
  }
});

test("requestUpdateStream relays a re-point control RPC to the capture controller", async () => {
  await withRelay(async (port, relay) => {
    const url = `ws://127.0.0.1:${port}/experimental/spatial/stream`;
    const controller = new WebSocket(url);
    await open(controller);
    await rpc(controller, "captureController", "register");

    const updateCall = nextJson(controller, (m) => m.params?.func === "updateStream");
    relay.requestUpdateStream("sess-7", "https://docs.google.com/document/d/xyz/edit");
    const msg = await updateCall;
    expect(msg.params.target).toBe("captureController");
    expect(msg.params.args).toEqual(["sess-7", "https://docs.google.com/document/d/xyz/edit"]);

    controller.close();
  });
});

test("googleWorkspaceViewUrl maps GWS actions to public view URLs", () => {
  // ids from args (read/update actions)
  expect(googleWorkspaceViewUrl("docs_update_document", { documentId: "D1" }, null)).toBe(
    "https://docs.google.com/document/d/D1/edit",
  );
  expect(googleWorkspaceViewUrl("slides_read_presentation", { presentationId: "P1" }, null)).toBe(
    "https://docs.google.com/presentation/d/P1/edit",
  );
  expect(googleWorkspaceViewUrl("sheets_get_values", { spreadsheetId: "S1" }, null)).toBe(
    "https://docs.google.com/spreadsheets/d/S1/edit",
  );
  expect(googleWorkspaceViewUrl("drive_update_file", { fileId: "F1" }, null)).toBe(
    "https://drive.google.com/file/d/F1/preview",
  );
  // id from the call result (create actions return a fresh id)
  expect(googleWorkspaceViewUrl("docs_create_document", {}, { result: { documentId: "NEW" } })).toBe(
    "https://docs.google.com/document/d/NEW/edit",
  );
  // non-file actions / missing ids → no URL
  expect(googleWorkspaceViewUrl("calendar_create_event", { summary: "x" }, null)).toBeNull();
  expect(googleWorkspaceViewUrl("docs_update_document", {}, null)).toBeNull();
});

test("coordinator starts on first GWS call and re-points on a doc switch", () => {
  const calls: Array<{ op: string; id: string; target?: unknown; url?: string }> = [];
  const fakeRelay = {
    requestStartStream: (id: string, target: unknown) => calls.push({ op: "start", id, target }),
    requestUpdateStream: (id: string, url: string) => calls.push({ op: "update", id, url }),
    requestStopStream: (id: string) => calls.push({ op: "stop", id }),
  } as unknown as SpatialStreamRelay;

  const coordinator = createSpatialStreamCoordinator(fakeRelay);
  try {
    const body = (action: string, args: Record<string, unknown>) => ({
      extensionId: "google-workspace",
      action,
      args,
      context: { sessionId: "sess-1" },
    });

    // First doc → start.
    coordinator.noteExtensionCall(body("docs_update_document", { documentId: "A" }), null);
    // Same doc again → idempotent, no new call.
    coordinator.noteExtensionCall(body("docs_read_document", { documentId: "A" }), null);
    // Different doc → re-point (not a second start).
    coordinator.noteExtensionCall(body("docs_update_document", { documentId: "B" }), null);
    // Non-GWS / no sessionId → ignored.
    coordinator.noteExtensionCall({ extensionId: "other", action: "x", args: {}, context: {} }, null);

    expect(calls).toEqual([
      { op: "start", id: "sess-1", target: { kind: "browser", url: "https://docs.google.com/document/d/A/edit" } },
      { op: "update", id: "sess-1", url: "https://docs.google.com/document/d/B/edit" },
    ]);
  } finally {
    coordinator.dispose();
  }
});

test("coordinator streams the screen for a computer-use session and ignores GWS downgrade", () => {
  const calls: Array<{ op: string; id: string; target?: unknown }> = [];
  const fakeRelay = {
    requestStartStream: (id: string, target: unknown) => calls.push({ op: "start", id, target }),
    requestUpdateStream: () => calls.push({ op: "update", id: "" }),
    requestStopStream: (id: string) => calls.push({ op: "stop", id }),
  } as unknown as SpatialStreamRelay;

  const coordinator = createSpatialStreamCoordinator(fakeRelay);
  try {
    const part = (tool: string) => ({
      type: "message.part.updated",
      properties: { part: { type: "tool", tool, sessionID: "cu-1" } },
    });

    // First computer-use tool part → screen stream starts.
    spatialEventsBroker.emit(part("computer-use_snapshot"));
    // More computer-use parts → idempotent (already streaming screen).
    spatialEventsBroker.emit(part("computer-use_click"));
    spatialEventsBroker.emit(part("cua_screenshot"));
    // A GWS call on the same session must NOT downgrade the screen to a browser.
    coordinator.noteSessionUrl("cu-1", "https://docs.google.com/document/d/Z/edit");
    // A non-computer-use tool part is ignored.
    spatialEventsBroker.emit(part("read"));

    expect(calls).toEqual([{ op: "start", id: "cu-1", target: { kind: "screen" } }]);
  } finally {
    coordinator.dispose();
  }
});

test("requestStartStream relays a control RPC to the capture controller", async () => {
  await withRelay(async (port, relay) => {
    const url = `ws://127.0.0.1:${port}/experimental/spatial/stream`;
    const controller = new WebSocket(url);
    await open(controller);
    await rpc(controller, "captureController", "register");

    const startCall = nextJson(controller, (m) => m.params?.func === "startStream");
    relay.requestStartStream("sess-42", { kind: "browser", url: "https://docs.google.com/document/d/abc/edit" });
    const msg = await startCall;
    expect(msg.params.target).toBe("captureController");
    expect(msg.params.args).toEqual(["sess-42", { kind: "browser", url: "https://docs.google.com/document/d/abc/edit" }]);

    controller.close();
  });
});

const DECK = slideOutlineFromPresentation({
  slides: [
    { objectId: "s1", pageElements: [{ objectId: "title1" }] },
    { objectId: "s2", pageElements: [{ objectId: "body2" }] },
    { objectId: "s3" },
  ],
});

test("slideOutlineFromPresentation keeps slide order and maps elements to slides", () => {
  expect(DECK).toEqual({ slideIds: ["s1", "s2", "s3"], elementToSlide: { title1: "s1", body2: "s2" } });
  expect(slideOutlineFromPresentation({ presentationId: "p" })).toBeNull();
  expect(slideOutlineFromPresentation(null)).toBeNull();
});

test("slideTargetFromCall picks the last request that names a slide", () => {
  const act = "slides_update_presentation";
  // explicit createSlide id (the agent chose it)
  expect(slideTargetFromCall(act, { requests: [{ createSlide: { objectId: "new_slide_cat" } }] }, null, DECK)).toBe("new_slide_cat");
  // generated id comes back in the matching reply
  const reqs = [{ insertText: { objectId: "title1", text: "x" } }, { createSlide: { insertionIndex: 3 } }];
  const res = { result: { replies: [{}, { createSlide: { objectId: "SLIDES_API1_0" } }] } };
  expect(slideTargetFromCall(act, { requests: reqs }, res, DECK)).toBe("SLIDES_API1_0");
  // element edits resolve to their slide; later requests win
  expect(slideTargetFromCall(act, { requests: [{ insertText: { objectId: "title1" } }, { insertText: { objectId: "body2" } }] }, null, DECK)).toBe("s2");
  // pageObjectId on a new element
  expect(slideTargetFromCall(act, { requests: [{ createImage: { url: "u", elementProperties: { pageObjectId: "s3" } } }] }, null, DECK)).toBe("s3");
  // replaceImage names the element as imageObjectId; replaceAllShapesWithImage lists pages
  expect(slideTargetFromCall(act, { requests: [{ replaceImage: { imageObjectId: "body2", url: "u" } }] }, null, DECK)).toBe("s2");
  expect(slideTargetFromCall(act, { requests: [{ replaceAllShapesWithImage: { pageObjectIds: ["s3"], imageUrl: "u" } }] }, null, DECK)).toBe("s3");
  // deleting a slide names it directly
  expect(slideTargetFromCall(act, { requests: [{ deleteObject: { objectId: "s1" } }] }, null, DECK)).toBe("s1");
  // unknown element without an outline: nothing
  expect(slideTargetFromCall(act, { requests: [{ insertText: { objectId: "ghost" } }] }, null, null)).toBeNull();
  expect(slideTargetFromCall("slides_read_presentation", { presentationId: "p" }, null, DECK)).toBeNull();
});

test("coordinator follows the edited slide and pages the deck while waiting", () => {
  const calls: Array<{ op: string; id: string; url?: string; target?: unknown }> = [];
  const fakeRelay = {
    requestStartStream: (id: string, target: unknown) => calls.push({ op: "start", id, target }),
    requestUpdateStream: (id: string, url: string) => calls.push({ op: "update", id, url }),
    requestStopStream: (id: string) => calls.push({ op: "stop", id }),
  } as unknown as SpatialStreamRelay;
  const coordinator = createSpatialStreamCoordinator(fakeRelay);
  const ctx = { context: { sessionId: "sess-s" }, extensionId: "google-workspace" };
  const base = "https://docs.google.com/presentation/d/P1/edit";

  // read gives the outline; window opens on the plain edit URL
  coordinator.noteExtensionCall({ ...ctx, action: "slides_read_presentation", args: { presentationId: "P1" } }, {
    result: { presentationId: "P1", slides: [{ objectId: "s1" }, { objectId: "s2", pageElements: [{ objectId: "body2" }] }, { objectId: "s3" }] },
  });
  expect(calls).toEqual([{ op: "start", id: "sess-s", target: { kind: "browser", url: base } }]);

  // an edit re-points the same window at the edited slide
  coordinator.noteExtensionCall({ ...ctx, action: "slides_update_presentation", args: { presentationId: "P1", requests: [{ insertText: { objectId: "body2", text: "hi" } }] } }, { result: { replies: [{}] } });
  expect(calls.at(-1)).toEqual({ op: "update", id: "sess-s", url: `${base}#slide=id.s2` });

  // a later read does not yank the screen back to slide 1
  calls.length = 0;
  coordinator.noteExtensionCall({ ...ctx, action: "slides_read_presentation", args: { presentationId: "P1" } }, { result: { presentationId: "P1", slides: [{ objectId: "s1" }, { objectId: "s2" }, { objectId: "s3" }] } });
  expect(calls).toEqual([]);

  // paging: clamps at both ends
  expect(coordinator.stepSlide("sess-s", 1)).toEqual({ ok: true, index: 2, count: 3 });
  expect(calls.at(-1)?.url).toBe(`${base}#slide=id.s3`);
  expect(coordinator.stepSlide("sess-s", 1)).toEqual({ ok: true, index: 2, count: 3 });
  expect(coordinator.stepSlide("sess-s", -5)).toEqual({ ok: true, index: 0, count: 3 });
  expect(calls.at(-1)?.url).toBe(`${base}#slide=id.s1`);
  // no deck on this session
  expect(coordinator.stepSlide("sess-doc", 1)).toEqual({ ok: false });
  coordinator.dispose();
});

test("lastSlideMention picks the last slide the text names", () => {
  expect(lastSlideMention("I'm now focused on slide 2 and then Slide #4 needs an image")).toBe(4);
  expect(lastSlideMention("The third slide has three images")).toBe(3);
  expect(lastSlideMention("The deck has 5 slides")).toBeNull();
  expect(lastSlideMention("")).toBeNull();
});

test("a deck opened by file id is pageable once the outline fetch lands", async () => {
  const calls: string[] = [];
  const fakeRelay = {
    requestStartStream: () => calls.push("start"),
    requestUpdateStream: (_id: string, url: string) => calls.push(url),
    requestStopStream: () => calls.push("stop"),
  } as unknown as SpatialStreamRelay;
  const coordinator = createSpatialStreamCoordinator(fakeRelay);
  coordinator.setSlideOutlineFetcher(async (id) => (id === "P9" ? { slideIds: ["a", "b"], elementToSlide: {} } : null));
  coordinator.noteSessionUrl("sess-open", "https://docs.google.com/presentation/d/P9/edit");
  await new Promise((r) => setTimeout(r, 0));
  expect(coordinator.stepSlide("sess-open", 1)).toEqual({ ok: true, index: 1, count: 2 });
  expect(calls.at(-1)).toBe("https://docs.google.com/presentation/d/P9/edit#slide=id.b");
  coordinator.dispose();
});

test("a bare deck URL from the prompt route keeps the page the user turned to", async () => {
  const calls: string[] = [];
  const fakeRelay = {
    requestStartStream: () => calls.push("start"),
    requestUpdateStream: (_id: string, url: string) => calls.push(url),
    requestStopStream: () => calls.push("stop"),
  } as unknown as SpatialStreamRelay;
  const coordinator = createSpatialStreamCoordinator(fakeRelay);
  coordinator.setSlideOutlineFetcher(async () => ({ slideIds: ["a", "b", "c"], elementToSlide: {} }));
  const base = "https://docs.google.com/presentation/d/P5/edit";
  coordinator.noteSessionUrl("sess-r", base);
  await new Promise((r) => setTimeout(r, 0));
  coordinator.stepSlide("sess-r", 2); // user paged to slide 3 while the agent stood by
  calls.length = 0;
  coordinator.noteSessionUrl("sess-r", base); // resume prompt carries the fileId -> bare URL
  expect(calls).toEqual([]); // no re-point: still on slide 3
  coordinator.noteSessionDoc("sess-r", "P5"); // docs-style URL for a different deck type: unrelated, re-points
  expect(calls.at(-1)).toContain("/document/d/P5/edit");
  coordinator.dispose();
});
