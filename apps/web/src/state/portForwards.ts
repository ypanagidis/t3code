import { useAtomValue } from "@effect/atom-react";
import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import {
  type PortForwardCredential,
  resolvePortForwardCredential,
} from "@t3tools/client-runtime/state/portForwardAccess";
import {
  AuthTerminalOperateScope,
  type DesktopBridge,
  type DesktopPortForward,
  type EnvironmentId,
  type ExecutionEnvironmentCapabilities,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useEnvironment } from "./environments";
import { environmentSession, useEnvironmentScope, usePreparedConnection } from "./session";

/**
 * TCP port forwards hosted by desktop main. Each one listens on 127.0.0.1 on
 * this computer and pipes connections to a port on a remote environment over
 * a WebSocket. Desktop only; browsers and mobile cannot listen on TCP.
 */
type PortForwardBridge = Required<
  Pick<
    DesktopBridge,
    | "startPortForward"
    | "stopPortForward"
    | "listPortForwards"
    | "updatePortForwardCredential"
    | "onPortForwardsChanged"
  >
>;

export function getPortForwardBridge(): PortForwardBridge | null {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  if (bridge === undefined) return null;
  const {
    startPortForward,
    stopPortForward,
    listPortForwards,
    updatePortForwardCredential,
    onPortForwardsChanged,
  } = bridge;
  // Desktop builds predating port forwarding lack these.
  if (
    startPortForward === undefined ||
    stopPortForward === undefined ||
    listPortForwards === undefined ||
    updatePortForwardCredential === undefined ||
    onPortForwardsChanged === undefined
  ) {
    return null;
  }
  return {
    startPortForward,
    stopPortForward,
    listPortForwards,
    updatePortForwardCredential,
    onPortForwardsChanged,
  };
}

/**
 * Whether this client can forward ports from an environment. Only direct
 * routes qualify: SSH rides its own tunnel and bearer links connect straight
 * to the server. T3 Connect never carries forwarded traffic, and the primary
 * environment is this machine already. The server route needs terminal
 * access, so a session without it cannot forward.
 */
export function canForwardPorts(input: {
  readonly bridgeSupported: boolean;
  readonly connected: boolean;
  readonly canOperateTerminal: boolean;
  readonly target: ConnectionTarget | null;
  readonly capabilities:
    | Pick<ExecutionEnvironmentCapabilities, "tcpPortForwarding">
    | null
    | undefined;
}): boolean {
  const { bridgeSupported, connected, canOperateTerminal, target } = input;
  if (!bridgeSupported || !connected || !canOperateTerminal || target === null) return false;
  if (input.capabilities?.tcpPortForwarding !== true) return false;
  switch (target._tag) {
    case "SshConnectionTarget":
    case "BearerConnectionTarget":
      return true;
    case "PrimaryConnectionTarget":
    case "RelayConnectionTarget":
      return false;
  }
}

export function useCanForwardPorts(environmentId: EnvironmentId | null): boolean {
  const environment = useEnvironment(environmentId);
  const prepared = usePreparedConnection(environmentId);
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  return canForwardPorts({
    bridgeSupported: getPortForwardBridge() !== null,
    connected: environment?.connection.phase === "connected",
    canOperateTerminal,
    target: Option.isSome(prepared) ? prepared.value.target : null,
    capabilities: environment?.serverConfig?.environment.capabilities,
  });
}

const EMPTY_FORWARDS: ReadonlyArray<DesktopPortForward> = [];

const portForwardsAtom = Atom.make(
  Stream.callback<ReadonlyArray<DesktopPortForward>>((queue) =>
    Effect.gen(function* () {
      const bridge = getPortForwardBridge();
      if (bridge === null) return yield* Effect.never;
      let received = false;
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          bridge.onPortForwardsChanged((forwards) => {
            received = true;
            Queue.offerUnsafe(queue, forwards);
          }),
        ),
        (unsubscribe) => Effect.sync(unsubscribe),
      );
      const initial = yield* Effect.tryPromise(() => bridge.listPortForwards()).pipe(
        Effect.catch((error) =>
          Effect.logError("Failed to list port forwards", { error }).pipe(Effect.as(null)),
        ),
      );
      if (!received && initial !== null) Queue.offerUnsafe(queue, initial);
      return yield* Effect.never;
    }),
  ),
  { initialValue: EMPTY_FORWARDS },
).pipe(Atom.keepAlive, Atom.withLabel("desktop:port-forwards"));

export function usePortForwards(): ReadonlyArray<DesktopPortForward> {
  return AsyncResult.getOrElse(useAtomValue(portForwardsAtom), () => EMPTY_FORWARDS);
}

// Keyed on the prepared connection, so a re-pair or a new SSH tunnel port
// produces a new base URL and ticket.
const portForwardCredentialAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.never;
      return resolvePortForwardCredential(prepared);
    })
    .pipe(Atom.withLabel(`port-forward-credential:${environmentId}`)),
);

/** Mints a fresh ticket for desktop main to open forwarded connections with. */
export function readPortForwardCredential(
  environmentId: EnvironmentId,
): Promise<PortForwardCredential> {
  const atom = portForwardCredentialAtom(environmentId);
  appAtomRegistry.refresh(atom);
  return Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, atom, { suspendOnWaiting: true }).pipe(
      Effect.timeout("10 seconds"),
    ),
  );
}

export async function startPortForward(input: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly remotePort: number;
  readonly localPort?: number | undefined;
}): Promise<DesktopPortForward> {
  const bridge = getPortForwardBridge();
  if (bridge === null) throw new Error("Port forwarding needs the T3 Code desktop app.");
  const credential = await readPortForwardCredential(input.environmentId);
  return bridge.startPortForward({
    environmentId: input.environmentId,
    environmentLabel: input.environmentLabel,
    remotePort: input.remotePort,
    ...(input.localPort === undefined ? {} : { localPort: input.localPort }),
    ...credential,
  });
}

export async function stopPortForward(forwardId: string): Promise<void> {
  await getPortForwardBridge()?.stopPortForward(forwardId);
}

/** Parses a TCP port typed by the user; null when it is not 1..65535. */
export function parsePortInput(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= 1 && port <= 65_535 ? port : null;
}
