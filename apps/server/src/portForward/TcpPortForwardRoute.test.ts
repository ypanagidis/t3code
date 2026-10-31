import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthSessionId,
  AuthTerminalOperateScope,
  TCP_PORT_FORWARD_ROUTE,
  TCP_PORT_FORWARD_UPSTREAM_FAILED_CLOSE_CODE,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/http";
import * as NodeNet from "node:net";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as TcpPortForwardRoute from "./TcpPortForwardRoute.ts";

const authLayer = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  Layer.mock(EnvironmentAuth.EnvironmentAuth, {
    authenticateWebSocketUpgrade: () =>
      Effect.succeed({
        sessionId: AuthSessionId.make("port-forward-test"),
        subject: "port-forward-test",
        method: "bearer-access-token",
        scopes,
      }),
  });

/** A loopback TCP server, closed with the scope. */
const listen = (onConnection: (socket: NodeNet.Socket) => void, options?: NodeNet.ServerOpts) =>
  Effect.acquireRelease(
    Effect.callback<NodeNet.Server>((resume) => {
      const server = NodeNet.createServer(options ?? {}, onConnection);
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  ).pipe(Effect.map((server) => (server.address() as NodeNet.AddressInfo).port));

const serveRoute = Effect.gen(function* () {
  const services = yield* Layer.build(
    HttpRouter.serve(TcpPortForwardRoute.layer, { disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provide(authLayer([AuthTerminalOperateScope])),
    ),
  );
  const server = Context.get(services, HttpServer.HttpServer);
  return HttpServer.formatAddress(server.address).replace(/^http/, "ws");
});

const openForward = (origin: string, port: number) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const socket = new WebSocket(
        `${origin}${TCP_PORT_FORWARD_ROUTE}?port=${port}&wsTicket=ticket`,
      );
      socket.binaryType = "arraybuffer";
      const opened = new Promise((resolve) => socket.addEventListener("open", resolve));
      const firstMessage = new Promise<Uint8Array>((resolve) =>
        socket.addEventListener("message", (event) =>
          resolve(new Uint8Array(event.data as ArrayBuffer)),
        ),
      );
      const closed = new Promise<CloseEvent>((resolve) =>
        socket.addEventListener("close", resolve),
      );
      return { socket, opened, firstMessage, closed };
    }),
    ({ socket }) => Effect.sync(() => socket.close()),
  );

it.effect("pipes bytes both ways to a loopback port", () =>
  Effect.gen(function* () {
    const port = yield* listen((socket) => socket.pipe(socket));
    const origin = yield* serveRoute;
    const { socket, opened, firstMessage } = yield* openForward(origin, port);
    yield* Effect.promise(() => opened);
    socket.send(new Uint8Array([1, 2, 3, 0, 255]));
    expect(yield* Effect.promise(() => firstMessage)).toEqual(new Uint8Array([1, 2, 3, 0, 255]));
  }).pipe(Effect.scoped),
);

it.effect("closes the WebSocket normally when the TCP side ends", () =>
  Effect.gen(function* () {
    const port = yield* listen((socket) => socket.end("bye"));
    const origin = yield* serveRoute;
    const { firstMessage, closed } = yield* openForward(origin, port);
    const greeting = yield* Effect.promise(() => firstMessage);
    expect(new TextDecoder().decode(greeting)).toBe("bye");
    expect((yield* Effect.promise(() => closed)).code).toBe(1000);
  }).pipe(Effect.scoped),
);

it.effect("passes a client half-close through and still delivers the reply", () =>
  Effect.gen(function* () {
    // Replies only once the request side ends, like `nc -N` against Redis.
    const port = yield* listen(
      (socket) => {
        const received: Buffer[] = [];
        socket.on("data", (chunk: Buffer) => received.push(chunk));
        socket.on("end", () => socket.end(`got:${Buffer.concat(received).toString()}`));
      },
      { allowHalfOpen: true },
    );
    const origin = yield* serveRoute;
    const { socket, opened, firstMessage, closed } = yield* openForward(origin, port);
    yield* Effect.promise(() => opened);
    socket.send(new TextEncoder().encode("PING"));
    socket.send(new Uint8Array(0));
    expect(new TextDecoder().decode(yield* Effect.promise(() => firstMessage))).toBe("got:PING");
    expect((yield* Effect.promise(() => closed)).code).toBe(1000);
  }).pipe(Effect.scoped),
);

it.effect("closes with the upstream-failed code when nothing listens on the port", () =>
  Effect.gen(function* () {
    // Reserve a port, then free it so the dial is refused.
    const port = yield* Effect.scoped(listen(() => {}));
    const origin = yield* serveRoute;
    const { closed } = yield* openForward(origin, port);
    const event = yield* Effect.promise(() => closed);
    expect(event.code).toBe(TCP_PORT_FORWARD_UPSTREAM_FAILED_CLOSE_CODE);
    expect(event.reason).toBe(`Cannot connect to localhost:${port}`);
  }).pipe(Effect.scoped),
);

const request = (scopes: ReadonlyArray<AuthEnvironmentScope>, query: string, upgrade = true) =>
  Effect.gen(function* () {
    const { handler } = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          TcpPortForwardRoute.layer.pipe(Layer.provideMerge(authLayer(scopes))),
          {
            disableLogger: true,
          },
        ),
      ),
      ({ dispose }) => Effect.promise(dispose),
    );
    const response = yield* Effect.promise(() =>
      handler(
        new Request(`http://t3.test${TCP_PORT_FORWARD_ROUTE}${query}`, {
          headers: upgrade ? { upgrade: "websocket" } : {},
        }),
      ),
    );
    return response.status;
  }).pipe(Effect.scoped);

it.effect("requires terminal operate scope", () =>
  Effect.gen(function* () {
    expect(yield* request([AuthOrchestrationOperateScope], "?port=5173")).toBe(403);
  }),
);

it.effect.each(["", "?port=0", "?port=65536", "?port=abc", "?port=1e3", "?port=-1"])(
  "rejects an invalid port (%s)",
  (query) =>
    Effect.gen(function* () {
      expect(yield* request([AuthTerminalOperateScope], query)).toBe(400);
    }),
);

it.effect("requires a WebSocket upgrade", () =>
  Effect.gen(function* () {
    expect(yield* request([AuthTerminalOperateScope], "?port=5173", false)).toBe(426);
  }),
);
