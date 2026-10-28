import {
  type GuestMessageAttribution,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type OrchestrationV2IdleCompaction,
  ScheduledTaskId,
} from "@t3tools/contracts";

/** The working row while T3 Code's own compaction runs. */
export const IDLE_COMPACTING_LABELS = {
  beforeCacheExpires: "Compacting before the cache expires…",
  onReturn: "Compacting after being idle…",
} satisfies Record<OrchestrationV2IdleCompaction, string>;

/** Leads the finished compaction's token counts, in place of "Context compacted". */
export const IDLE_COMPACTION_TITLES = {
  beforeCacheExpires: "Context automatically compacted before cache expiry",
  onReturn: "Context compacted after being idle",
} satisfies Record<OrchestrationV2IdleCompaction, string>;

const LEGACY_AUTOMATION_PREFIX = /^\[Triggered by schedule task: [^\r\n]+\]\r?\n\r?\n/;
const LEGACY_AUTOMATION_MESSAGE_ID = /^scheduled-task-message:(.+):\d+:(?:scheduled|manual)$/;
const CLAUDE_ULTRATHINK_LINE = /^Ultrathink:\r?\n/;
// An invisible separator after the blank line marks the prefix as injected, so the
// same token typed by the user stays visible. It trails the token because both
// providers only recognise the invocation when it is the first text.
const POTETO_MODE_MARKER = "\u2063";
const POTETO_MODE_PREFIX = /^(Ultrathink:\r?\n)?([$/](?:[\w:-]*:)?poteto-mode)\r?\n\r?\n\u2063/;
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
  return `${ultrathink}${invocation}\n\n${POTETO_MODE_MARKER}${text.slice(ultrathink.length)}`;
}

/** The poteto-mode invocation a sent prompt was prefixed with, if any. */
export function readPotetoModeInvocation(text: string): string | null {
  const match = POTETO_MODE_PREFIX.exec(text);
  return match?.[2] ?? null;
}

export function stripPotetoModePrefix(text: string): string {
  return text.replace(POTETO_MODE_PREFIX, "$1");
}

export function resolveUserMessagePresentation(message: {
  readonly id?: string;
  readonly role: string;
  readonly text: string;
  readonly createdBy?: OrchestrationV2Actor;
  readonly creationSource?: OrchestrationV2CreationSource;
  readonly scheduledTaskId?: ScheduledTaskId | undefined;
  readonly context?: { readonly guest?: GuestMessageAttribution | undefined } | undefined;
}): {
  readonly text: string;
  readonly attribution: "automation" | "agent" | "t3code" | "guest" | null;
  readonly scheduledTaskId: ScheduledTaskId | undefined;
  /** Set when `attribution` is "guest". */
  readonly guestName?: string;
} {
  if (message.role !== "user") {
    return { text: message.text, attribution: null, scheduledTaskId: undefined };
  }
  // The stored text names the guest for the agent; people see the guest's own words.
  const guest = message.context?.guest;
  if (guest !== undefined) {
    return {
      text: guest.text,
      attribution: "guest",
      scheduledTaskId: undefined,
      guestName: guest.name,
    };
  }
  const text = stripPotetoModePrefix(message.text);
  if (message.scheduledTaskId !== undefined) {
    return {
      text,
      attribution: "automation",
      scheduledTaskId: message.scheduledTaskId,
    };
  }
  const legacyPrefix = LEGACY_AUTOMATION_PREFIX.exec(text);
  const legacyTaskId = legacyPrefix
    ? LEGACY_AUTOMATION_MESSAGE_ID.exec(message.id ?? "")?.[1]
    : undefined;
  if (legacyPrefix !== null && (legacyTaskId !== undefined || message.createdBy === "agent")) {
    return {
      text: text.slice(legacyPrefix[0].length),
      attribution: "automation",
      scheduledTaskId: legacyTaskId === undefined ? undefined : ScheduledTaskId.make(legacyTaskId),
    };
  }
  return {
    text,
    attribution:
      message.createdBy !== "agent"
        ? null
        : message.creationSource === "server"
          ? "t3code"
          : "agent",
    scheduledTaskId: undefined,
  };
}
