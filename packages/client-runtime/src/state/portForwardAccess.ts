/**
 * Credentials desktop main uses to open port-forward WebSockets for one
 * environment. Desktop main cannot send this client's bearer or DPoP headers,
 * so each forwarded TCP connection authenticates with a WebSocket ticket. A
 * ticket lives five minutes and is reusable for its lifetime, so callers mint a
 * fresh one well before it expires and on every reconnect.
 */
import type { DesktopPortForwardCredentialInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { HttpClient } from "effect/http";

import type { PreparedConnection } from "../connection/model.ts";
import type { RemoteEnvironmentRequestError } from "../rpc/http.ts";
import { mintEnvironmentWebSocketTicket } from "./deviceHubAccess.ts";

export type PortForwardCredential = Omit<DesktopPortForwardCredentialInput, "environmentId">;

export class PortForwardCredentialUnavailableError extends Schema.TaggedError<PortForwardCredentialUnavailableError>()(
  "PortForwardCredentialUnavailableError",
  {},
) {
  override get message(): string {
    return "This connection has no credential desktop main can use for port forwarding.";
  }
}

/** The environment origin as a `ws:`/`wss:` URL, without path, query, or hash. */
export function portForwardWsBaseUrl(httpBaseUrl: string): string {
  return new URL(httpBaseUrl).origin.replace(/^http/, "ws");
}

export const resolvePortForwardCredential = Effect.fn(
  "clientRuntime.state.resolvePortForwardCredential",
)(function* (
  prepared: PreparedConnection,
): Effect.fn.Return<
  PortForwardCredential,
  RemoteEnvironmentRequestError | PortForwardCredentialUnavailableError,
  HttpClient.HttpClient
> {
  // Cookie sessions belong to the browser; desktop main cannot present them.
  if (prepared.httpAuthorization === null) {
    return yield* new PortForwardCredentialUnavailableError();
  }
  const wsTicket = yield* mintEnvironmentWebSocketTicket(prepared);
  return { wsBaseUrl: portForwardWsBaseUrl(prepared.httpBaseUrl), wsTicket };
});
