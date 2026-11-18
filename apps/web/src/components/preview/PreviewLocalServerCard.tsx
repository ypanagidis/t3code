import type { ScopedThreadRef } from "@t3tools/contracts";
import { msg, useMessages } from "gt-react";
import { MonitorDownIcon } from "lucide-react";
import { useState } from "react";

import type { MessageResolver } from "../../i18n/messages";
import { useEnvironment } from "~/state/environments";
import { startPortForward, useCanForwardPorts } from "~/state/portForwards";
import { Button } from "../ui/button";
import { DiscoveryListRow } from "../ui/discovery-list";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

import { PreviewFaviconIcon } from "./PreviewFaviconIcon";
import type { PreviewableServer } from "./useDiscoveredLocalServers";

interface Props {
  threadRef: ScopedThreadRef;
  server: PreviewableServer;
  onOpen: () => void;
}

export function PreviewLocalServerCard({ threadRef, server, onOpen }: Props) {
  const m = useMessages();
  const subtitle = describeServer(server, m);
  const canForward = useCanForwardPorts(threadRef.environmentId);
  const row = (
    <DiscoveryListRow
      onClick={onOpen}
      icon={<PreviewFaviconIcon threadRef={threadRef} url={server.requestedUrl} />}
      title={subtitle}
      description={`${server.host}:${server.port}`}
      // Keeps the text clear of the forward button laid over the row's end.
      action={canForward ? <span aria-hidden className="size-6 shrink-0" /> : undefined}
    />
  );
  if (!canForward) return row;
  return (
    <div className="relative flex items-center">
      {row}
      <div className="absolute right-3">
        <ForwardServerPortButton threadRef={threadRef} port={server.port} />
      </div>
    </div>
  );
}

/** Forwards the server's port to 127.0.0.1 on this computer. Desktop only. */
function ForwardServerPortButton({
  threadRef,
  port,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly port: number;
}) {
  const environment = useEnvironment(threadRef.environmentId);
  const [starting, setStarting] = useState(false);
  const forward = async () => {
    setStarting(true);
    try {
      const result = await startPortForward({
        environmentId: threadRef.environmentId,
        // oxlint-disable-next-line t3code/no-untranslated-copy -- fork-only feature, English only
        environmentLabel: environment?.label ?? "Remote environment",
        remotePort: port,
      });
      toastManager.add({
        type: "success",
        // oxlint-disable-next-line t3code/no-untranslated-copy -- fork-only feature, English only
        title: `Port ${port} forwarded`,
        // oxlint-disable-next-line t3code/no-untranslated-copy -- fork-only feature, English only
        description: `Open 127.0.0.1:${result.localPort} on this computer. Manage forwards in Settings → Connections.`,
      });
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          // oxlint-disable-next-line t3code/no-untranslated-copy -- fork-only feature, English only
          title: `Could not forward port ${port}`,
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setStarting(false);
    }
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost-muted"
            size="icon-xs"
            disabled={starting}
            // oxlint-disable-next-line t3code/no-untranslated-copy -- fork-only feature, English only
            aria-label={`Forward port ${port} to this computer`}
            onClick={() => void forward()}
          />
        }
      >
        <MonitorDownIcon className="size-3.5" />
      </TooltipTrigger>
      {/* oxlint-disable-next-line t3code/no-untranslated-copy -- fork-only feature, English only */}
      <TooltipPopup side="top">Forward to this computer</TooltipPopup>
    </Tooltip>
  );
}

function describeServer(server: PreviewableServer, resolve: MessageResolver): string {
  if (server.processName) return server.processName;
  return resolve(msg("Listening", { $context: "a local server is listening on a port" }));
}
