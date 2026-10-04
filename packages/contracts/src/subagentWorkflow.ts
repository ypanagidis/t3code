import * as Schema from "effect/Schema";

/**
 * Live shape of a provider-native multi-agent workflow (Claude's Workflow
 * tool), carried on the workflow's `subagent` turn item. Each update replaces
 * the whole value, so clients render it as a snapshot.
 */
export const OrchestrationV2SubagentWorkflowAgent = Schema.Struct({
  index: Schema.Number,
  label: Schema.optional(Schema.String),
  phaseIndex: Schema.optional(Schema.Number),
  status: Schema.Literals(["pending", "running", "completed", "failed"]),
  model: Schema.optional(Schema.String),
  lastToolName: Schema.optional(Schema.String),
  toolCalls: Schema.optional(Schema.Number),
  tokens: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
});
export type OrchestrationV2SubagentWorkflowAgent = typeof OrchestrationV2SubagentWorkflowAgent.Type;

export const OrchestrationV2SubagentWorkflow = Schema.Struct({
  name: Schema.optional(Schema.String),
  phases: Schema.Array(Schema.Struct({ index: Schema.Number, title: Schema.String })),
  agents: Schema.Array(OrchestrationV2SubagentWorkflowAgent),
});
export type OrchestrationV2SubagentWorkflow = typeof OrchestrationV2SubagentWorkflow.Type;
