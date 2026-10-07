import type { DesktopPortForward } from "@t3tools/contracts";
import { ArrowRightIcon, CopyIcon, XIcon } from "lucide-react";
import { type FormEvent, useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import type { EnvironmentPresentation } from "~/state/environments";
import { parsePortInput, startPortForward, stopPortForward } from "~/state/portForwards";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Ports from one environment forwarded to 127.0.0.1 on this computer, with a
 * form to add another. Shown under the environment's row in Connections.
 * Existing forwards stay listed while the environment is disconnected so they
 * can still be stopped; the form needs a live, eligible connection.
 */
export function EnvironmentPortForwards({
  environment,
  forwards,
  canAdd,
}: {
  readonly environment: EnvironmentPresentation;
  readonly forwards: ReadonlyArray<DesktopPortForward>;
  readonly canAdd: boolean;
}) {
  return (
    <div className="mt-2 rounded-md border border-border/70">
      <p className="border-b border-border/70 px-2 py-1.5 text-xs font-medium text-foreground">
        Forwarded ports
      </p>
      {forwards.length > 0 ? (
        <ul aria-label={`Ports forwarded from ${environment.label}`}>
          {forwards.map((forward) => (
            <PortForwardRow key={forward.id} forward={forward} />
          ))}
        </ul>
      ) : null}
      {canAdd ? <AddPortForwardForm environment={environment} /> : null}
    </div>
  );
}

function PortForwardRow({ forward }: { readonly forward: DesktopPortForward }) {
  const address = `127.0.0.1:${forward.localPort}`;
  const [stopping, setStopping] = useState(false);
  const { copyToClipboard } = useCopyToClipboard<{ address: string }>({
    target: "forwarded address",
    onCopy: ({ address: copied }) => {
      toastManager.add({ type: "success", title: "Address copied", description: copied });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy address",
          description: error.message,
        }),
      );
    },
  });
  const stop = async () => {
    setStopping(true);
    try {
      await stopPortForward(forward.id);
    } catch (error) {
      setStopping(false);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not stop port forward",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };
  const connections =
    forward.activeConnections === 1 ? "1 connection" : `${forward.activeConnections} connections`;

  return (
    <li className="flex items-center gap-2 border-b border-border/70 px-2 py-1.5">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1 font-mono text-xs text-foreground tabular-nums">
          {forward.remotePort}
          <ArrowRightIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          {address}
        </p>
        <p className="truncate text-2xs text-muted-foreground">
          {connections}
          {forward.lastError !== undefined ? (
            <span className="text-destructive"> · {forward.lastError}</span>
          ) : null}
        </p>
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost-muted"
              size="icon-xs"
              aria-label={`Copy ${address}`}
              onClick={() => copyToClipboard(address, { address })}
            />
          }
        >
          <CopyIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup side="top">Copy address</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost-muted"
              size="icon-xs"
              disabled={stopping}
              aria-label={`Stop forwarding port ${forward.remotePort}`}
              onClick={() => void stop()}
            />
          }
        >
          <XIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup side="top">Stop forwarding</TooltipPopup>
      </Tooltip>
    </li>
  );
}

function AddPortForwardForm({ environment }: { readonly environment: EnvironmentPresentation }) {
  const [remotePort, setRemotePort] = useState("");
  const [localPort, setLocalPort] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const remote = parsePortInput(remotePort);
    const local = localPort.trim() === "" ? undefined : parsePortInput(localPort);
    if (remote === null || local === null) {
      setError("Ports are numbers from 1 to 65535.");
      return;
    }
    setError(null);
    setStarting(true);
    try {
      await startPortForward({
        environmentId: environment.environmentId,
        environmentLabel: environment.label,
        remotePort: remote,
        localPort: local,
      });
      setRemotePort("");
      setLocalPort("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStarting(false);
    }
  };

  return (
    <form className="px-2 py-1.5" onSubmit={(event) => void submit(event)}>
      <div className="flex items-center gap-1.5">
        <div className="w-28">
          <Input
            size="compact"
            font="mono"
            inputMode="numeric"
            placeholder="Remote port"
            aria-label={`Port on ${environment.label}`}
            value={remotePort}
            onChange={(event) => setRemotePort(event.target.value)}
          />
        </div>
        <ArrowRightIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        <div className="w-28">
          <Input
            size="compact"
            font="mono"
            inputMode="numeric"
            placeholder="Local (same)"
            aria-label="Port on this computer, optional"
            value={localPort}
            onChange={(event) => setLocalPort(event.target.value)}
          />
        </div>
        <Button type="submit" size="xs" variant="outline" disabled={starting || remotePort === ""}>
          {starting ? "Forwarding…" : "Forward"}
        </Button>
      </div>
      {error !== null ? <p className="mt-1 text-2xs text-destructive">{error}</p> : null}
    </form>
  );
}
