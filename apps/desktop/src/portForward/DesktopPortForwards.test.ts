// @effect-diagnostics nodeBuiltinImport:off - The tests drive raw local TCP sockets, which HttpClient cannot express.
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  TCP_PORT_FORWARD_ROUTE,
  TCP_PORT_FORWARD_UPSTREAM_FAILED_CLOSE_CODE,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as NodeNet from "node:net";

import * as DesktopPortForwards from "./DesktopPortForwards.ts";

const environmentId = EnvironmentId.make("environment-1");

interface UpgradeRequest {
  readonly port: string | null;
  readonly wsTicket: string | null;
}

type FakeBehavior =
  /** Echoes binary frames. */
  | { readonly _tag: "echo" }
  /** Like a server that answers once the request side ends: replies with what it got, then closes. */
  | { readonly _tag: "replyOnHalfClose" }
  /** Closes with the upstream-failed code. */
  | { readonly _tag: "refuse" }
  /** Rejects the upgrade with an HTTP status. */
  | { readonly _tag: "reject"; readonly status: number }
  /** Sends `bytes` bytes and closes with 1000 straight away. */
  | { readonly _tag: "send"; readonly bytes: number };

/** A `ws` server standing in for the t3 port-forward route. */
const startFakeEnvironment = (behavior: FakeBehavior = { _tag: "echo" }) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{
          wsBaseUrl: string;
          requests: UpgradeRequest[];
          server: NodeSocket.NodeWS.WebSocketServer;
        }>((resolve) => {
          const requests: UpgradeRequest[] = [];
          const server = new NodeSocket.NodeWS.WebSocketServer({
            host: "127.0.0.1",
            port: 0,
            path: TCP_PORT_FORWARD_ROUTE,
            verifyClient: (_info, callback) =>
              behavior._tag === "reject" ? callback(false, behavior.status) : callback(true),
          });
          server.on("connection", (ws, request) => {
            const url = new URL(request.url ?? "/", "http://localhost");
            requests.push({
              port: url.searchParams.get("port"),
              wsTicket: url.searchParams.get("wsTicket"),
            });
            switch (behavior._tag) {
              case "refuse":
                ws.close(TCP_PORT_FORWARD_UPSTREAM_FAILED_CLOSE_CODE, "connect ECONNREFUSED");
                return;
              case "send":
                ws.send(Buffer.alloc(behavior.bytes, 7));
                ws.close(1000);
                return;
              case "replyOnHalfClose": {
                const received: Buffer[] = [];
                ws.on("message", (data: Buffer) => {
                  if (data.length > 0) {
                    received.push(data);
                    return;
                  }
                  ws.send(Buffer.concat(received));
                  ws.close(1000);
                });
                return;
              }
              default:
                ws.on("message", (data: Buffer) => ws.send(data));
            }
          });
          server.on("listening", () => {
            const address = server.address() as NodeNet.AddressInfo;
            resolve({ wsBaseUrl: `ws://127.0.0.1:${address.port}`, requests, server });
          });
        }),
    ),
    ({ server }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            for (const client of server.clients) client.terminate();
            server.close(() => resolve());
          }),
      ),
  );

/** Holds a 127.0.0.1 port busy for the test's lifetime. */
const occupyPort = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<NodeNet.Server>((resolve) => {
        const server = NodeNet.createServer();
        server.listen(0, "127.0.0.1", () => resolve(server));
      }),
  ),
  (server) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
).pipe(Effect.map((server) => (server.address() as NodeNet.AddressInfo).port));

const connect = (port: number) =>
  Effect.promise(
    () =>
      new Promise<NodeNet.Socket>((resolve, reject) => {
        const socket = NodeNet.connect({ host: "127.0.0.1", port }, () => resolve(socket));
        socket.once("error", reject);
      }),
  );

const readExactly = (socket: NodeNet.Socket, length: number) =>
  Effect.promise(
    () =>
      new Promise<string>((resolve) => {
        let received = Buffer.alloc(0);
        const onData = (chunk: Buffer) => {
          received = Buffer.concat([received, chunk]);
          if (received.length >= length) {
            socket.off("data", onData);
            resolve(received.toString("utf8"));
          }
        };
        socket.on("data", onData);
      }),
  );

/** Reads everything until the peer ends the stream. */
const readToEnd = (socket: NodeNet.Socket) =>
  Effect.promise(
    () =>
      new Promise<Buffer>((resolve) => {
        const chunks: Buffer[] = [];
        socket.on("data", (chunk: Buffer) => chunks.push(chunk));
        socket.once("end", () => resolve(Buffer.concat(chunks)));
      }),
  );

const waitForClose = (socket: NodeNet.Socket) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        if (socket.closed) {
          resolve();
          return;
        }
        socket.once("close", () => resolve());
        socket.resume();
      }),
  );

describe("DesktopPortForwards", () => {
  it.live("pipes TCP bytes through the environment WebSocket and stops cleanly", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const environment = yield* startFakeEnvironment();
        const remotePort = yield* occupyPort;
        const forwards = yield* DesktopPortForwards.make;

        const forward = yield* forwards.start({
          environmentId,
          environmentLabel: "Remote box",
          wsBaseUrl: environment.wsBaseUrl,
          wsTicket: "ticket-1",
          remotePort,
        });
        // remotePort is busy locally, so an implicit local port falls back to an ephemeral one.
        assert.notStrictEqual(forward.localPort, remotePort);

        const duplicate = yield* forwards.start({
          environmentId,
          environmentLabel: "Remote box",
          wsBaseUrl: environment.wsBaseUrl,
          wsTicket: "ticket-1",
          remotePort,
        });
        assert.strictEqual(duplicate.id, forward.id);

        const first = yield* connect(forward.localPort);
        first.write("hello");
        assert.strictEqual(yield* readExactly(first, 5), "hello");
        const [listed] = yield* forwards.list;
        assert.strictEqual(listed?.activeConnections, 1);

        yield* forwards.updateCredential({
          environmentId,
          wsBaseUrl: environment.wsBaseUrl,
          wsTicket: "ticket-2",
        });
        const second = yield* connect(forward.localPort);
        second.write("again");
        assert.strictEqual(yield* readExactly(second, 5), "again");

        assert.deepStrictEqual(environment.requests, [
          { port: String(remotePort), wsTicket: "ticket-1" },
          { port: String(remotePort), wsTicket: "ticket-2" },
        ]);

        yield* forwards.stop(forward.id);
        yield* waitForClose(first);
        yield* waitForClose(second);
        assert.deepStrictEqual(yield* forwards.list, []);
        const reconnect = yield* Effect.exit(connect(forward.localPort));
        assert.isTrue(Exit.isFailure(reconnect));
      }),
    ),
  );

  it.live("records the error when the remote port refuses", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const environment = yield* startFakeEnvironment({ _tag: "refuse" });
        const remotePort = yield* occupyPort;
        const forwards = yield* DesktopPortForwards.make;
        const forward = yield* forwards.start({
          environmentId,
          environmentLabel: "Remote box",
          wsBaseUrl: environment.wsBaseUrl,
          wsTicket: "ticket-1",
          remotePort,
        });

        const socket = yield* connect(forward.localPort);
        yield* waitForClose(socket);

        const [listed] = yield* forwards.list;
        assert.strictEqual(listed?.lastError, "connect ECONNREFUSED");
      }),
    ),
  );

  it.live("delivers every byte when the environment closes right after sending", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Far more than the socket buffers hold, so most of it is still queued
        // in desktop main when the close arrives.
        const bytes = 32 * 1024 * 1024;
        const environment = yield* startFakeEnvironment({ _tag: "send", bytes });
        const forwards = yield* DesktopPortForwards.make;
        const forward = yield* forwards.start({
          environmentId,
          environmentLabel: "Remote box",
          wsBaseUrl: environment.wsBaseUrl,
          wsTicket: "ticket-1",
          remotePort: yield* occupyPort,
        });

        const socket = yield* connect(forward.localPort);
        const received = yield* readToEnd(socket);
        assert.strictEqual(received.length, bytes);
      }),
    ),
  );

  it.live("passes a local half-close on and still delivers the reply", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const environment = yield* startFakeEnvironment({ _tag: "replyOnHalfClose" });
        const forwards = yield* DesktopPortForwards.make;
        const forward = yield* forwards.start({
          environmentId,
          environmentLabel: "Remote box",
          wsBaseUrl: environment.wsBaseUrl,
          wsTicket: "ticket-1",
          remotePort: yield* occupyPort,
        });

        const socket = yield* connect(forward.localPort);
        socket.end("PING");
        assert.strictEqual((yield* readToEnd(socket)).toString("utf8"), "PING");
      }),
    ),
  );

  it.live("reports an expired ticket separately from an unreachable environment", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const environment = yield* startFakeEnvironment({ _tag: "reject", status: 401 });
        const forwards = yield* DesktopPortForwards.make;
        const forward = yield* forwards.start({
          environmentId,
          environmentLabel: "Remote box",
          wsBaseUrl: environment.wsBaseUrl,
          wsTicket: "stale",
          remotePort: yield* occupyPort,
        });

        const socket = yield* connect(forward.localPort);
        yield* waitForClose(socket);

        const [listed] = yield* forwards.list;
        assert.strictEqual(
          listed?.lastError,
          "Access to the environment expired. Open T3 Code to refresh it.",
        );
      }),
    ),
  );

  it.live("fails when an explicit local port is busy", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const busyPort = yield* occupyPort;
        const forwards = yield* DesktopPortForwards.make;
        const result = yield* Effect.flip(
          forwards.start({
            environmentId,
            environmentLabel: "Remote box",
            wsBaseUrl: "ws://127.0.0.1:1",
            wsTicket: "ticket-1",
            remotePort: 5432,
            localPort: busyPort,
          }),
        );
        assert.strictEqual(result._tag, "DesktopPortForwardBindError");
        assert.strictEqual(result.localPort, busyPort);
        assert.deepStrictEqual(yield* forwards.list, []);
      }),
    ),
  );
});
