import { test, expect } from "bun:test";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocket } from "ws";

import { createSpatialStreamRelay } from "./spatial-stream-relay.js";
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

test("requestStartStream relays a control RPC to the capture controller", async () => {
  await withRelay(async (port, relay) => {
    const url = `ws://127.0.0.1:${port}/experimental/spatial/stream`;
    const controller = new WebSocket(url);
    await open(controller);
    await rpc(controller, "captureController", "register");

    const startCall = nextJson(controller, (m) => m.params?.func === "startStream");
    relay.requestStartStream("sess-42", "https://docs.google.com/document/d/abc/edit");
    const msg = await startCall;
    expect(msg.params.target).toBe("captureController");
    expect(msg.params.args).toEqual(["sess-42", "https://docs.google.com/document/d/abc/edit"]);

    controller.close();
  });
});
