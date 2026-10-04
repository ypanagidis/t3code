import type {
  OrchestrationV2SubagentWorkflow,
  OrchestrationV2SubagentWorkflowAgent,
} from "@t3tools/contracts";

// Caps bound what one task_progress frame can put on the wire.
const WORKFLOW_PHASE_CAP = 64;
const WORKFLOW_AGENT_CAP = 100;

const nonNegativeInt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

const trimmedString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

function workflowAgentStatus(
  state: string,
  started: boolean,
): OrchestrationV2SubagentWorkflowAgent["status"] {
  switch (state) {
    case "done":
      return "completed";
    case "error":
      return "failed";
    case "queued":
    case "pending":
      return "pending";
    default:
      return started ? "running" : "pending";
  }
}

/**
 * Reads the Claude CLI's `workflow_progress` array from a `task_progress`
 * frame of a `local_workflow` task. The field is undeclared in the SDK types,
 * so the parse is defensive: unknown entries are skipped and a missing or
 * empty array returns undefined, leaving the plain subagent lifecycle intact.
 */
export function parseClaudeWorkflowProgress(
  value: unknown,
): Omit<OrchestrationV2SubagentWorkflow, "name"> | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const phasesByIndex = new Map<number, string>();
  const agentsByIndex = new Map<number, OrchestrationV2SubagentWorkflowAgent>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const index = nonNegativeInt(record.index);
    if (index === undefined) continue;
    if (record.type === "workflow_phase") {
      const title = trimmedString(record.title);
      if (title !== undefined && !phasesByIndex.has(index)) phasesByIndex.set(index, title);
      continue;
    }
    const state = trimmedString(record.state);
    if (record.type !== "workflow_agent" || state === undefined) continue;
    const phaseIndex = nonNegativeInt(record.phaseIndex);
    const phaseTitle = trimmedString(record.phaseTitle);
    // Agents can name a phase the array never declared separately.
    if (phaseIndex !== undefined && phaseTitle !== undefined && !phasesByIndex.has(phaseIndex)) {
      phasesByIndex.set(phaseIndex, phaseTitle);
    }
    const label = trimmedString(record.label);
    const model = trimmedString(record.model);
    const lastToolName = trimmedString(record.lastToolName);
    const toolCalls = nonNegativeInt(record.toolCalls);
    const tokens = nonNegativeInt(record.tokens);
    const error = trimmedString(record.error);
    // The latest entry for a slot wins: retries re-report the same index.
    agentsByIndex.set(index, {
      index,
      status: workflowAgentStatus(state, record.startedAt !== undefined),
      ...(label === undefined ? {} : { label }),
      ...(phaseIndex === undefined ? {} : { phaseIndex }),
      ...(model === undefined ? {} : { model }),
      ...(lastToolName === undefined ? {} : { lastToolName }),
      ...(toolCalls === undefined ? {} : { toolCalls }),
      ...(tokens === undefined ? {} : { tokens }),
      ...(error === undefined ? {} : { error: error.slice(0, 500) }),
    });
  }
  if (phasesByIndex.size === 0 && agentsByIndex.size === 0) return undefined;
  return {
    phases: Array.from(phasesByIndex, ([index, title]) => ({ index, title }))
      .toSorted((a, b) => a.index - b.index)
      .slice(0, WORKFLOW_PHASE_CAP),
    agents: Array.from(agentsByIndex.values())
      .toSorted((a, b) => a.index - b.index)
      .slice(0, WORKFLOW_AGENT_CAP),
  };
}

/** Whether a parsed snapshot differs from the last one sent, ignoring the name. */
export function claudeWorkflowChanged(
  previous: OrchestrationV2SubagentWorkflow | undefined,
  next: Omit<OrchestrationV2SubagentWorkflow, "name">,
): boolean {
  return (
    previous === undefined ||
    JSON.stringify([previous.phases, previous.agents]) !==
      JSON.stringify([next.phases, next.agents])
  );
}
