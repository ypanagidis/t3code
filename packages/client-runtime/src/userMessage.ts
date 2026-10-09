import { type OrchestrationV2Actor, ScheduledTaskId } from "@t3tools/contracts";

const LEGACY_AUTOMATION_PREFIX = /^\[Triggered by schedule task: [^\r\n]+\]\r?\n\r?\n/;
const LEGACY_AUTOMATION_MESSAGE_ID = /^scheduled-task-message:(.+):\d+:(?:scheduled|manual)$/;
const CLAUDE_ULTRATHINK_LINE = /^Ultrathink:\r?\n/;
// The blank line after the token is what marks it as injected: a user who types
// the skill themselves writes their request on the same line.
const POTETO_MODE_PREFIX = /^(Ultrathink:\r?\n)?[$/](?:[\w:-]*:)?poteto-mode\r?\n\r?\n/;
const LEADING_SLASH_COMMAND = /^\/[^\s/]+(?:\s|$)/u;

/**
 * Leads `text` with the poteto-mode `invocation` so the provider starts the
 * skill first. Claude's ultrathink line stays on top, and a prompt that is
 * already a slash command or already carries the prefix is left alone, as is
 * every prompt when there is no `invocation`.
 */
export function applyPotetoModePrefix(text: string, invocation: string | null): string {
  if (
    invocation === null ||
    POTETO_MODE_PREFIX.test(text) ||
    LEADING_SLASH_COMMAND.test(text.trimStart())
  ) {
    return text;
  }
  const ultrathink = CLAUDE_ULTRATHINK_LINE.exec(text)?.[0] ?? "";
  return `${ultrathink}${invocation}\n\n${text.slice(ultrathink.length)}`;
}

/** The poteto-mode invocation a sent prompt was prefixed with, if any. */
export function readPotetoModeInvocation(text: string): string | null {
  const match = POTETO_MODE_PREFIX.exec(text);
  return match ? match[0].slice(match[1]?.length ?? 0).trimEnd() : null;
}

export function stripPotetoModePrefix(text: string): string {
  return text.replace(POTETO_MODE_PREFIX, "$1");
}

/**
 * The user-facing text of a message. Older scheduled messages stored their
 * attribution in the prompt itself, and poteto mode's injected prefix is hidden.
 */
export function resolveUserMessagePresentation(message: {
  readonly id?: string;
  readonly role: string;
  readonly text: string;
  readonly createdBy?: OrchestrationV2Actor;
  readonly scheduledTaskId?: ScheduledTaskId;
}) {
  if (message.role !== "user") {
    return { text: message.text, isAutomation: false, scheduledTaskId: undefined };
  }
  const text = stripPotetoModePrefix(message.text);
  if (message.scheduledTaskId !== undefined) {
    return { text, isAutomation: true, scheduledTaskId: message.scheduledTaskId };
  }
  const legacyPrefix = LEGACY_AUTOMATION_PREFIX.exec(text);
  const legacyTaskId = legacyPrefix
    ? LEGACY_AUTOMATION_MESSAGE_ID.exec(message.id ?? "")?.[1]
    : undefined;
  const isAutomation =
    legacyPrefix !== null && (legacyTaskId !== undefined || message.createdBy === "agent");
  return {
    text: isAutomation ? text.slice(legacyPrefix[0].length) : text,
    isAutomation,
    scheduledTaskId: legacyTaskId === undefined ? undefined : ScheduledTaskId.make(legacyTaskId),
  };
}
