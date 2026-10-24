// @effect-diagnostics globalTimers:off -- Change coalescing and throughput sampling run at node:net socket callback boundaries outside Effect fibers.
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  TCP_PORT_FORWARD_ROUTE,
  TCP_PORT_FORWARD_UPSTREAM_FAILED_CLOSE_CODE,
  type DesktopPortForward,
  type DesktopPortForwardCredentialInput,
  type DesktopPortForwardStartInput,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as NodeNet from "node:net";
import * as NodePerfHooks from "node:perf_hooks";

const NodeWS = NodeSocket.NodeWS;
/** A zero-length binary frame tells the environment the local client half-closed. */
const HALF_CLOSE_FRAME = new Uint8Array(0);

/** Pause reading local TCP bytes while this much is unflushed on the WebSocket. */
const WEBSOCKET_HIGH_WATER_MARK = 1024 * 1024;
/** Coalesces change events so a burst of connections sends one update. */
const CHANGE_EMIT_DELAY_MS = 100;
/** Throughput sampling period. The sampler only runs while some forward carries traffic. */
const THROUGHPUT_SAMPLE_MS = 1000;

export class DesktopPortForwardBindError extends Schema.TaggedError<DesktopPortForwardBindError>()(
  "DesktopPortForwardBindError",
  {
    localPort: Schema.Number,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Could not listen on 127.0.0.1:${this.localPort}: ${this.reason}`;
  }
}

export type DesktopPortForwardsListener = (
  forwards: readonly DesktopPortForward[],
) => Effect.Effect<void>;

export class DesktopPortForwards extends Context.Service<
  DesktopPortForwards,
  {
    /** Starts a forward, or returns the existing one for the same environment and remote port. */
    readonly start: (
      input: DesktopPortForwardStartInput,
    ) => Effect.Effect<DesktopPortForward, DesktopPortForwardBindError>;
    readonly stop: (forwardId: string) => Effect.Effect<void>;
    readonly list: Effect.Effect<readonly DesktopPortForward[]>;
    /** Replaces the credential that new connections for the environment use. */
    readonly updateCredential: (input: DesktopPortForwardCredentialInput) => Effect.Effect<void>;
    /** Receives the full forward list, coalesced, whenever it changes. */
    readonly subscribe: (
      listener: DesktopPortForwardsListener,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/portForward/DesktopPortForwards") {}

interface Credential {
  readonly wsBaseUrl: string;
  readonly wsTicket: string;
}

interface ForwardEntry {
  readonly id: string;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly remotePort: number;
  readonly localPort: number;
  readonly server: NodeNet.Server;
  readonly sockets: Set<NodeNet.Socket>;
  lastError: string | undefined;
  bytesReceived: number;
  bytesSent: number;
  /** Totals at the previous throughput sample. */
  sampledReceived: number;
  sampledSent: number;
  receiveBytesPerSecond: number;
  sendBytesPerSecond: number;
}

/** Byte counters a piped connection reports into. */
interface TrafficCounter {
  readonly received: (bytes: number) => void;
  readonly sent: (bytes: number) => void;
}

const toForward = (entry: ForwardEntry): DesktopPortForward => ({
  id: entry.id,
  environmentId: entry.environmentId,
  environmentLabel: entry.environmentLabel,
  remotePort: entry.remotePort,
  localPort: entry.localPort,
  activeConnections: entry.sockets.size,
  bytesReceived: entry.bytesReceived,
  bytesSent: entry.bytesSent,
  receiveBytesPerSecond: entry.receiveBytesPerSecond,
  sendBytesPerSecond: entry.sendBytesPerSecond,
  ...(entry.lastError === undefined ? {} : { lastError: entry.lastError }),
});

export const makePortForwardUrl = (credential: Credential, remotePort: number): string => {
  const url = new URL(`${credential.wsBaseUrl.replace(/\/+$/, "")}${TCP_PORT_FORWARD_ROUTE}`);
  url.searchParams.set("port", String(remotePort));
  url.searchParams.set("wsTicket", credential.wsTicket);
  return url.toString();
};

const listen = (port: number) =>
  Effect.callback<NodeNet.Server, NodeJS.ErrnoException>((resume) => {
    // Paused until the WebSocket opens so no local bytes arrive before there is
    // somewhere to send them. Half-open so a client that ends its request side
    // still receives the reply.
    const server = NodeNet.createServer({ pauseOnConnect: true, allowHalfOpen: true });
    const onError = (error: NodeJS.ErrnoException) => {
      server.close();
      resume(Effect.fail(error));
    };
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port }, () => {
      server.off("error", onError);
      resume(Effect.succeed(server));
    });
  });

const boundPort = (server: NodeNet.Server): number => {
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
};

const rejectionMessage = (statusCode: number | undefined): string => {
  switch (statusCode) {
    case 401:
      return "Access to the environment expired. Open T3 Code to refresh it.";
    case 403:
      return "This device does not have terminal access on the environment.";
    default:
      return `The environment rejected the connection (HTTP ${statusCode ?? "error"}).`;
  }
};

const toBuffer = (data: NodeSocket.NodeWS.RawData): Buffer =>
  Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);

/**
 * Pipes one accepted TCP socket through one WebSocket, with backpressure both
 * ways. A local half-close is passed on and the reply still flows back; a
 * clean WebSocket close ends the local socket after its pending bytes flush,
 * and anything else destroys it. `onFailure` receives a message when the
 * connection never reached the remote port.
 */
const pipeSocket = (
  socket: NodeNet.Socket,
  url: string,
  traffic: TrafficCounter,
  onFailure: (message: string) => void,
  onSuccess: () => void,
) => {
  socket.setNoDelay(true);
  // Forwarded bytes are often already compressed, and deflate would hide
  // queued bytes from the backpressure below.
  const ws = new NodeWS.WebSocket(url, { perMessageDeflate: false });
  let opened = false;
  let localClosed = false;
  let rejection: string | undefined;
  let unflushed = 0;

  ws.on("unexpected-response", (_request, response) => {
    rejection = rejectionMessage(response.statusCode);
    response.resume();
    // Aborts the handshake; ws then emits "error" and "close".
    ws.terminate();
  });
  // ws always follows "error" with "close", which does the cleanup.
  ws.on("error", () => {});
  ws.on("open", () => {
    opened = true;
    socket.resume();
  });
  ws.on("message", (data) => {
    const bytes = toBuffer(data);
    traffic.received(bytes.length);
    if (!socket.write(bytes)) ws.pause();
  });
  socket.on("drain", () => ws.resume());
  ws.on("close", (code, reason) => {
    if (code === TCP_PORT_FORWARD_UPSTREAM_FAILED_CLOSE_CODE) {
      onFailure(reason.toString() || "The remote port refused the connection.");
    } else if (rejection !== undefined) {
      onFailure(rejection);
    } else if (opened) {
      onSuccess();
    } else if (!localClosed) {
      // A local client that gave up before the handshake is not a failure.
      onFailure("Could not reach the environment.");
    }
    if (opened && (code === 1000 || code === 1005)) {
      socket.end();
    } else {
      socket.destroy();
    }
  });

  socket.on("data", (chunk: Buffer) => {
    traffic.sent(chunk.length);
    unflushed += chunk.length;
    ws.send(chunk, () => {
      unflushed -= chunk.length;
      if (unflushed <= WEBSOCKET_HIGH_WATER_MARK && socket.isPaused()) socket.resume();
    });
    if (unflushed > WEBSOCKET_HIGH_WATER_MARK) socket.pause();
  });
  socket.on("end", () => {
    if (ws.readyState === NodeWS.WebSocket.OPEN) ws.send(HALF_CLOSE_FRAME);
  });
  socket.on("close", () => {
    localClosed = true;
    if (ws.readyState === NodeWS.WebSocket.CONNECTING) {
      ws.terminate();
    } else if (ws.readyState === NodeWS.WebSocket.OPEN) {
      ws.close(1000);
    }
  });
  // "close" follows and closes the WebSocket.
  socket.on("error", () => {});
};

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const forwards = new Map<string, ForwardEntry>();
  const credentials = new Map<EnvironmentId, Credential>();
  const listeners = new Set<DesktopPortForwardsListener>();
  let nextId = 1;
  let emitTimer: ReturnType<typeof setTimeout> | undefined;
  let sampleTimer: ReturnType<typeof setInterval> | undefined;
  let sampledAt = 0;

  const snapshot = (): readonly DesktopPortForward[] => Array.from(forwards.values(), toForward);

  const emitChanged = () => {
    if (emitTimer !== undefined) return;
    emitTimer = setTimeout(() => {
      emitTimer = undefined;
      const current = snapshot();
      for (const listener of listeners) {
        runFork(listener(current));
      }
    }, CHANGE_EMIT_DELAY_MS);
  };

  // Recomputes per-forward throughput once a second and publishes it through
  // the coalesced change event. Stops itself once every forward is idle and
  // its rates have been reported as zero, so idle forwards cost nothing.
  const sampleThroughput = () => {
    const now = NodePerfHooks.performance.now();
    const seconds = Math.max((now - sampledAt) / 1000, 0.001);
    sampledAt = now;
    let changed = false;
    let busy = false;
    for (const entry of forwards.values()) {
      const receiveRate = Math.round((entry.bytesReceived - entry.sampledReceived) / seconds);
      const sendRate = Math.round((entry.bytesSent - entry.sampledSent) / seconds);
      entry.sampledReceived = entry.bytesReceived;
      entry.sampledSent = entry.bytesSent;
      if (receiveRate !== entry.receiveBytesPerSecond || sendRate !== entry.sendBytesPerSecond) {
        entry.receiveBytesPerSecond = receiveRate;
        entry.sendBytesPerSecond = sendRate;
        changed = true;
      }
      if (entry.sockets.size > 0 || receiveRate > 0 || sendRate > 0) busy = true;
    }
    if (changed) emitChanged();
    if (!busy && sampleTimer !== undefined) {
      clearInterval(sampleTimer);
      sampleTimer = undefined;
    }
  };

  const ensureSampling = () => {
    if (sampleTimer !== undefined) return;
    sampledAt = NodePerfHooks.performance.now();
    sampleTimer = setInterval(sampleThroughput, THROUGHPUT_SAMPLE_MS);
  };

  const acceptConnection = (entry: ForwardEntry, socket: NodeNet.Socket) => {
    const credential = credentials.get(entry.environmentId);
    if (credential === undefined) {
      socket.destroy();
      return;
    }
    entry.sockets.add(socket);
    ensureSampling();
    socket.once("close", () => {
      entry.sockets.delete(socket);
      emitChanged();
    });
    pipeSocket(
      socket,
      makePortForwardUrl(credential, entry.remotePort),
      {
        received: (bytes) => {
          entry.bytesReceived += bytes;
        },
        sent: (bytes) => {
          entry.bytesSent += bytes;
        },
      },
      (message) => {
        entry.lastError = message;
      },
      () => {
        entry.lastError = undefined;
      },
    );
    emitChanged();
  };

  const closeEntry = (entry: ForwardEntry) => {
    entry.server.close();
    for (const socket of entry.sockets) {
      socket.destroy();
    }
  };

  const start: DesktopPortForwards["Service"]["start"] = Effect.fn("desktop.portForwards.start")(
    function* (input) {
      credentials.set(input.environmentId, {
        wsBaseUrl: input.wsBaseUrl,
        wsTicket: input.wsTicket,
      });
      for (const entry of forwards.values()) {
        if (entry.environmentId === input.environmentId && entry.remotePort === input.remotePort) {
          return toForward(entry);
        }
      }

      const requestedPort = input.localPort ?? input.remotePort;
      const server = yield* listen(requestedPort).pipe(
        // Any bind failure on an implicit port (busy, or privileged like 80
        // without root) falls back to a free one, as the docs promise.
        Effect.catchIf(
          () => input.localPort === undefined,
          () => listen(0),
        ),
        Effect.mapError(
          (error) =>
            new DesktopPortForwardBindError({
              localPort: requestedPort,
              reason: error.code === "EADDRINUSE" ? "the port is already in use" : error.message,
            }),
        ),
      );

      const entry: ForwardEntry = {
        id: `port-forward-${nextId++}`,
        environmentId: input.environmentId,
        environmentLabel: input.environmentLabel,
        remotePort: input.remotePort,
        localPort: boundPort(server),
        server,
        sockets: new Set(),
        lastError: undefined,
        bytesReceived: 0,
        bytesSent: 0,
        sampledReceived: 0,
        sampledSent: 0,
        receiveBytesPerSecond: 0,
        sendBytesPerSecond: 0,
      };
      server.on("connection", (socket) => acceptConnection(entry, socket));
      server.on("error", (error) => {
        runFork(Effect.logWarning("Port forward listener failed", { id: entry.id, error }));
      });
      forwards.set(entry.id, entry);
      emitChanged();
      return toForward(entry);
    },
  );

  const stop: DesktopPortForwards["Service"]["stop"] = (forwardId) =>
    Effect.sync(() => {
      const entry = forwards.get(forwardId);
      if (entry === undefined) return;
      forwards.delete(forwardId);
      closeEntry(entry);
      emitChanged();
    });

  const updateCredential: DesktopPortForwards["Service"]["updateCredential"] = (input) =>
    Effect.sync(() => {
      credentials.set(input.environmentId, {
        wsBaseUrl: input.wsBaseUrl,
        wsTicket: input.wsTicket,
      });
    });

  const subscribe: DesktopPortForwards["Service"]["subscribe"] = (listener) =>
    Effect.acquireRelease(
      Effect.sync(() => listeners.add(listener)),
      () => Effect.sync(() => listeners.delete(listener)),
    ).pipe(Effect.asVoid);

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (emitTimer !== undefined) clearTimeout(emitTimer);
      if (sampleTimer !== undefined) clearInterval(sampleTimer);
      for (const entry of forwards.values()) {
        closeEntry(entry);
      }
      forwards.clear();
      listeners.clear();
    }),
  );

  return DesktopPortForwards.of({
    start,
    stop,
    list: Effect.sync(snapshot),
    updateCredential,
    subscribe,
  });
});

export const layer = Layer.effect(DesktopPortForwards, make);
