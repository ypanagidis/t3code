/**
 * TCP port forwarding over WebSocket.
 *
 * Each WebSocket on `TCP_PORT_FORWARD_ROUTE?port=<n>` is one TCP connection to
 * this machine's loopback interface. Binary frames carry raw bytes both ways
 * with no framing protocol; either side closing ends the other. A
 * zero-length binary frame from the client is a half-close: the TCP write side
 * ends and replies keep flowing until the TCP side closes. The route
 * never accepts a host, so it cannot be used to reach other machines, and it
 * requires terminal operate scope because reaching local services is
 * shell-equivalent.
 */
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  AuthTerminalOperateScope,
  TCP_PORT_FORWARD_ROUTE,
  TCP_PORT_FORWARD_UPSTREAM_FAILED_CLOSE_CODE,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";

import { authenticateMediaRequest } from "../auth/http.ts";

const parsePort = (value: string | null) => {
  if (value === null || !/^\d{1,5}$/.test(value)) return undefined;
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : undefined;
};

/**
 * Dial the loopback port, trying IPv4 then IPv6 so services bound to only one
 * of `127.0.0.1` or `::1` both work. Returns the socket with its reader
 * acquired, which is what performs the connect.
 */
const connectLoopback = (port: number) => {
  const open = (host: string) =>
    Effect.gen(function* () {
      const socket = yield* NodeSocket.makeNet({ host, port, openTimeout: "5 seconds" });
      const reader = yield* socket.reader;
      // The writer gets its own scope so a client half-close can end() just
      // the TCP write side while replies keep arriving on the reader.
      const writerScope = yield* Scope.fork(yield* Effect.scope);
      const writer = yield* Scope.provide(socket.writer, writerScope);
      return { reader, writer, endWriter: Scope.close(writerScope, Exit.void) };
    });
  return open("127.0.0.1").pipe(Effect.catch(() => open("::1")));
};

type Transport = ReturnType<typeof NodeHttpServerRequest.toIncomingMessage>["socket"];

/** Wait until the client transport flushes before reading more TCP bytes. */
const awaitTransportDrain = (transport: Transport) =>
  transport.writableNeedDrain
    ? Effect.callback<void>((resume) => {
        const done = () => {
          cleanup();
          resume(Effect.void);
        };
        const cleanup = () => {
          transport.off("drain", done);
          transport.off("close", done);
        };
        transport.on("drain", done);
        transport.on("close", done);
        return Effect.sync(cleanup);
      })
    : Effect.void;

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.headers.upgrade?.toLowerCase() !== "websocket") {
    return HttpServerResponse.text("Upgrade Required", { status: 426 });
  }
  const url = HttpServerRequest.toURL(request);
  const port = Option.isSome(url) ? parsePort(url.value.searchParams.get("port")) : undefined;
  if (port === undefined) {
    return HttpServerResponse.text("Bad Request", { status: 400 });
  }
  yield* authenticateMediaRequest(AuthTerminalOperateScope);

  const incoming = NodeHttpServerRequest.toIncomingMessage(request);
  // Forwarded bytes are often already compressed. Without deflate, every
  // pending write sits in the transport buffer that backpressure watches.
  delete incoming.headers["sec-websocket-extensions"];
  const transport = incoming.socket;
  // Nothing else probes the client: without keepalive, a client that vanishes
  // without a FIN would hold the upstream connection open forever.
  transport.setKeepAlive(true, 30_000);
  const client = yield* request.upgrade;

  yield* Effect.scoped(
    Effect.gen(function* () {
      // The reader performs the upgrade; writes wait for it.
      const fromClient = yield* client.reader;
      const toClient = yield* client.writer;
      const upstream = yield* connectLoopback(port).pipe(Effect.option);
      if (Option.isNone(upstream)) {
        yield* toClient.write(
          new Socket.CloseEvent(
            TCP_PORT_FORWARD_UPSTREAM_FAILED_CLOSE_CODE,
            `Cannot connect to localhost:${port}`,
          ),
        );
        return;
      }
      const { reader: fromTcp, writer: toTcp, endWriter } = upstream.value;
      const tcpToClient = Effect.gen(function* () {
        while (true) {
          yield* toClient.writeAll(yield* fromTcp.pull);
          yield* awaitTransportDrain(transport);
        }
      });
      // The TCP writer awaits `drain`, and the client reader pauses the
      // WebSocket at its high-water mark, so this direction is bounded too.
      // After a half-close the loop keeps pulling only to notice the client
      // closing; any further bytes have nowhere to go.
      const clientToTcp = Effect.gen(function* () {
        let halfClosed = false;
        while (true) {
          const chunks = yield* fromClient.pull;
          if (halfClosed) continue;
          const eofIndex = chunks.findIndex((chunk) => chunk.length === 0);
          const data = eofIndex === -1 ? chunks : chunks.slice(0, eofIndex);
          if (Arr.isReadonlyArrayNonEmpty(data)) yield* toTcp.writeAll(data);
          if (eofIndex !== -1) {
            halfClosed = true;
            yield* endWriter;
          }
        }
      });
      // Either side ending fails its pull and wins the race; scope teardown
      // then closes the other side. A clean end closes the WebSocket with 1000.
      yield* Effect.raceFirst(tcpToClient, clientToTcp).pipe(Effect.ignore);
    }),
  ).pipe(Effect.ignoreCause);
  return HttpServerResponse.empty();
});

export const layer = HttpRouter.add("GET", TCP_PORT_FORWARD_ROUTE, handler);
