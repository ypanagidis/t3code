import * as Schema from "effect/Schema";

import { EnvironmentId, NonNegativeInt, PortSchema } from "./baseSchemas.ts";

/**
 * TCP port forwarding over a direct environment connection.
 *
 * Each forwarded TCP connection is one WebSocket to
 * `${environmentWsOrigin}${TCP_PORT_FORWARD_ROUTE}?port=<remotePort>&wsTicket=<ticket>`.
 * Binary frames carry raw bytes in both directions; either side closing ends
 * the other. A zero-length binary frame from the client means the local client
 * half-closed: the server ends its TCP write side and keeps sending replies
 * until the remote port closes. The server only dials its own loopback interface. Relay
 * connections never forward ports.
 */
export const TCP_PORT_FORWARD_ROUTE = "/api/port-forward/ws";

/** The server could not connect to the requested loopback port. */
export const TCP_PORT_FORWARD_UPSTREAM_FAILED_CLOSE_CODE = 4502;

export const DesktopPortForwardStartInput = Schema.Struct({
  environmentId: EnvironmentId,
  environmentLabel: Schema.String,
  /** Environment origin as a `ws:`/`wss:` URL, without the route path. */
  wsBaseUrl: Schema.String,
  /** Short-lived WebSocket ticket for the environment session. */
  wsTicket: Schema.String,
  remotePort: PortSchema,
  /** Local port to bind on 127.0.0.1. Absent tries `remotePort`, then any free port. */
  localPort: Schema.optionalKey(PortSchema),
});
export type DesktopPortForwardStartInput = typeof DesktopPortForwardStartInput.Type;

export const DesktopPortForwardCredentialInput = Schema.Struct({
  environmentId: EnvironmentId,
  wsBaseUrl: Schema.String,
  wsTicket: Schema.String,
});
export type DesktopPortForwardCredentialInput = typeof DesktopPortForwardCredentialInput.Type;

export const DesktopPortForward = Schema.Struct({
  id: Schema.String,
  environmentId: EnvironmentId,
  environmentLabel: Schema.String,
  remotePort: PortSchema,
  localPort: PortSchema,
  activeConnections: NonNegativeInt,
  /** Bytes the environment sent to local clients since the forward started. */
  bytesReceived: NonNegativeInt,
  /** Bytes local clients sent to the environment since the forward started. */
  bytesSent: NonNegativeInt,
  /** Receive and send throughput over the most recent sampling second. Zero when idle. */
  receiveBytesPerSecond: NonNegativeInt,
  sendBytesPerSecond: NonNegativeInt,
  /** Message from the most recent connection that failed to reach the remote port. */
  lastError: Schema.optionalKey(Schema.String),
});
export type DesktopPortForward = typeof DesktopPortForward.Type;
