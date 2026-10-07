import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { useConnectedEnvironmentIds } from "../../state/environments";
import {
  getPortForwardBridge,
  readPortForwardCredential,
  stopPortForward,
  usePortForwards,
} from "../../state/portForwards";
import { usePreparedConnection } from "../../state/session";

// Tickets live five minutes; refresh with room for a slow request.
const CREDENTIAL_REFRESH_INTERVAL_MS = 3 * 60_000;
// Timers stall during system sleep, so age is checked against the wall clock
// often enough that a ticket is replaced soon after waking.
const CREDENTIAL_AGE_CHECK_MS = 30_000;

/**
 * Desktop only. Keeps every environment with a port forward supplied with a
 * fresh WebSocket ticket, so new connections to a forwarded port keep
 * authenticating, and stops forwards whose environment was removed from this
 * device. Does nothing while there are no forwards.
 */
export function PortForwardCoordinator() {
  const forwards = usePortForwards();
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const environmentIds = [...new Set(forwards.map((forward) => forward.environmentId))];
  const seenEnvironmentIds = useRef(new Set<EnvironmentId>());

  // A removed environment takes its forwards with it. A disconnect does not:
  // the forward keeps listening and resumes once the environment is back.
  // Only an environment this renderer saw leave counts as removed, because
  // platform backends such as WSL join the catalog after it first loads.
  useEffect(() => {
    if (!catalog.isReady) return;
    const seen = seenEnvironmentIds.current;
    for (const environmentId of catalog.entries.keys()) seen.add(environmentId);
    for (const forward of forwards) {
      if (seen.has(forward.environmentId) && !catalog.entries.has(forward.environmentId)) {
        void stopPortForward(forward.id);
      }
    }
  }, [catalog, forwards]);

  return environmentIds.map((environmentId) => (
    <PortForwardCredentialRefresher key={environmentId} environmentId={environmentId} />
  ));
}

function PortForwardCredentialRefresher({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const prepared = usePreparedConnection(environmentId);
  const connected = useConnectedEnvironmentIds().includes(environmentId);

  // Re-runs on reconnect: the prepared connection or connected flag changes.
  useEffect(() => {
    const bridge = getPortForwardBridge();
    if (bridge === null || !connected || prepared._tag === "None") return;
    let cancelled = false;
    let refreshedAt = 0;
    const refresh = () => {
      refreshedAt = Date.now();
      readPortForwardCredential(environmentId)
        .then((credential) => {
          if (cancelled) return;
          return bridge.updatePortForwardCredential({ environmentId, ...credential });
        })
        .catch((error: unknown) => {
          console.warn("Could not refresh port forward credential", { environmentId, error });
        });
    };
    refresh();
    const timer = window.setInterval(() => {
      if (Date.now() - refreshedAt >= CREDENTIAL_REFRESH_INTERVAL_MS) refresh();
    }, CREDENTIAL_AGE_CHECK_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [environmentId, prepared, connected]);

  return null;
}
