import { useAtomValue } from "@effect/atom-react";
import type {
  OrchestrationV2SubagentWorkflow,
  OrchestrationV2SubagentWorkflowAgent,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "~/lib/utils";
import { environmentThreadDetails } from "../../state/threads";

const AGENT_DOT_CLASS: Record<OrchestrationV2SubagentWorkflowAgent["status"], string> = {
  pending: "border border-muted-foreground/40",
  running: "bg-primary",
  completed: "bg-success",
  failed: "bg-destructive",
};

function agentSummary(agent: OrchestrationV2SubagentWorkflowAgent): string {
  return [
    agent.label ?? `Agent ${agent.index + 1}`,
    agent.status,
    agent.model,
    agent.toolCalls === undefined ? undefined : `${agent.toolCalls} tool calls`,
    agent.status === "running" ? agent.lastToolName : undefined,
    agent.error,
  ]
    .filter((part) => part !== undefined)
    .join(" · ");
}

/** Agents grouped under their phase, in phase order; phaseless agents last. */
function workflowPhaseGroups(workflow: OrchestrationV2SubagentWorkflow) {
  const groups = workflow.phases.map((phase) => ({
    key: `phase-${phase.index}`,
    title: phase.title,
    agents: workflow.agents.filter((agent) => agent.phaseIndex === phase.index),
  }));
  const known = new Set(workflow.phases.map((phase) => phase.index));
  const loose = workflow.agents.filter(
    (agent) => agent.phaseIndex === undefined || !known.has(agent.phaseIndex),
  );
  if (loose.length > 0) groups.push({ key: "agents", title: "Agents", agents: loose });
  return groups;
}

/**
 * Phase-by-phase view of a Claude Workflow run, drawn under the workflow's
 * subagent row: one line per phase with a status dot per agent. Clicking it
 * expands a card listing each agent's details.
 */
export function WorkflowProgress({
  workflow,
  className = "ms-9 me-2 mb-1.5",
}: {
  workflow: OrchestrationV2SubagentWorkflow;
  /** Placement; defaults to indenting under a subagent row. */
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const groups = workflowPhaseGroups(workflow);
  if (groups.length === 0) return null;
  return (
    <div
      data-workflow-progress
      className={cn(
        "flex flex-col rounded-md text-2xs",
        expanded && "border border-border bg-muted/30",
        className,
      )}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className={cn(
          "flex w-full min-w-0 flex-col gap-1 rounded-md text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring",
          expanded ? "px-2 py-1.5" : "-mx-1 px-1 py-0.5",
        )}
      >
        {expanded ? (
          <span className="flex min-w-0 items-center gap-1.5 font-medium text-foreground">
            <span className="min-w-0 flex-1 truncate">{workflow.name ?? "Workflow"}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
          </span>
        ) : (
          groups.map((group) => (
            <span key={group.key} className="flex min-w-0 items-center gap-2">
              <span className="w-28 shrink-0 truncate text-muted-foreground">{group.title}</span>
              <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                {group.agents.map((agent) => (
                  <AgentDot key={agent.index} agent={agent} />
                ))}
              </span>
              <PhaseCount agents={group.agents} />
            </span>
          ))
        )}
      </button>
      {expanded ? (
        <div className="flex flex-col gap-2 border-t border-border px-2 py-1.5">
          {groups.map((group) => (
            <div key={group.key} className="flex min-w-0 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-2 font-medium text-foreground">
                <span className="min-w-0 flex-1 truncate">{group.title}</span>
                <PhaseCount agents={group.agents} />
              </span>
              {group.agents.map((agent) => (
                <AgentRow key={agent.index} agent={agent} />
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AgentDot({ agent }: { agent: OrchestrationV2SubagentWorkflowAgent }) {
  return (
    <span
      aria-label={agentSummary(agent)}
      className={cn("size-2 shrink-0 rounded-full", AGENT_DOT_CLASS[agent.status])}
    />
  );
}

function PhaseCount({ agents }: { agents: ReadonlyArray<OrchestrationV2SubagentWorkflowAgent> }) {
  if (agents.length === 0) return null;
  const done = agents.filter((agent) => agent.status === "completed").length;
  const failed = agents.some((agent) => agent.status === "failed");
  return (
    <span
      className={cn(
        "shrink-0 font-mono text-3xs",
        failed ? "text-destructive" : "text-muted-foreground/80",
      )}
    >
      {done}/{agents.length}
    </span>
  );
}

function AgentRow({ agent }: { agent: OrchestrationV2SubagentWorkflowAgent }) {
  const details = [
    agent.model,
    agent.toolCalls === undefined
      ? undefined
      : `${agent.toolCalls} ${agent.toolCalls === 1 ? "tool" : "tools"}`,
    agent.tokens === undefined ? undefined : `${agent.tokens.toLocaleString()} tokens`,
  ].filter((part) => part !== undefined);
  return (
    <div className="flex min-w-0 flex-col ps-1">
      <span className="flex min-w-0 items-center gap-2">
        <AgentDot agent={agent} />
        <span className="min-w-0 flex-1 truncate text-foreground/90">
          {agent.label ?? `Agent ${agent.index + 1}`}
        </span>
        {agent.status === "running" && agent.lastToolName !== undefined ? (
          <span className="shrink-0 truncate font-mono text-3xs text-muted-foreground">
            {agent.lastToolName}
          </span>
        ) : null}
        {details.length > 0 ? (
          <span className="shrink-0 text-3xs text-muted-foreground/80">{details.join(" · ")}</span>
        ) : null}
      </span>
      {agent.error !== undefined ? (
        <span className="ps-4 text-destructive break-words">{agent.error}</span>
      ) : null}
    </div>
  );
}

/** Live workflows among the subagents a settled thread is waiting on, for the composer strip. */
export function PendingWorkflowProgress({
  parentRef,
  childThreadIds,
}: {
  parentRef: ScopedThreadRef;
  childThreadIds: ReadonlyArray<ThreadId>;
}) {
  const subagents = useAtomValue(
    environmentThreadDetails.threadAtom(parentRef),
    (thread) => thread?.projection.subagents,
  );
  const workflows = (subagents ?? []).flatMap((agent) =>
    agent.workflow !== undefined &&
    agent.childThreadId !== null &&
    childThreadIds.includes(agent.childThreadId)
      ? [agent]
      : [],
  );
  if (workflows.length === 0) return null;
  return workflows.map((agent) =>
    agent.workflow === undefined ? null : (
      <WorkflowProgress key={agent.id} workflow={agent.workflow} className="mt-1" />
    ),
  );
}
