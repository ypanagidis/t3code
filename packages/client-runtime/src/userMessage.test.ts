import { describe, expect, it } from "vite-plus/test";

import { GuestMessageId } from "@t3tools/contracts";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";

import {
  applyPotetoModePrefix,
  readPotetoModeInvocation,
  resolveUserMessagePresentation,
} from "./userMessage.ts";

describe("resolveUserMessagePresentation", () => {
  const legacyText = "[Triggered by schedule task: Daily audit]\n\nCheck for crashes.\n";

  it("preserves user-written and assistant-quoted schedule headers", () => {
    for (const message of [
      { role: "user", createdBy: "user" as const },
      { role: "user" },
      { role: "assistant", createdBy: "agent" as const },
    ]) {
      expect(resolveUserMessagePresentation({ ...message, text: legacyText })).toEqual({
        text: legacyText,
        attribution: null,
        scheduledTaskId: undefined,
      });
    }
  });

  it("hides the prompt that stands in for an attachment-only message", () => {
    for (const text of [
      ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
      `Ultrathink:\n${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT}`,
    ]) {
      expect(resolveUserMessagePresentation({ role: "user", text })).toEqual({
        text: "",
        attribution: null,
        scheduledTaskId: undefined,
      });
    }
  });

  it("shows a guest's own words and name, not the attributed text the agent reads", () => {
    expect(
      resolveUserMessagePresentation({
        role: "user",
        createdBy: "user",
        text: "Message from guest Sam, sent by the owner:\n\nWhy?",
        context: {
          guest: {
            guestMessageId: GuestMessageId.make("guest-message:one"),
            name: "Sam",
            text: "Why?",
          },
        },
      }),
    ).toEqual({ text: "Why?", attribution: "guest", scheduledTaskId: undefined, guestName: "Sam" });
  });

  it("attributes older server-sent restart continuations to T3 Code, not another agent", () => {
    const text = "Note: the T3 server restarted.";
    expect(
      resolveUserMessagePresentation({
        role: "user",
        createdBy: "agent",
        creationSource: "server",
        text,
      }),
    ).toMatchObject({ attribution: "t3code" });
    for (const creationSource of ["mcp", "provider"] as const) {
      expect(
        resolveUserMessagePresentation({ role: "user", createdBy: "agent", creationSource, text }),
      ).toMatchObject({ attribution: "agent" });
    }
  });

  it("recovers the triggering automation from older scheduler message ids", () => {
    for (const trigger of ["scheduled", "manual"]) {
      expect(
        resolveUserMessagePresentation({
          id: `scheduled-task-message:task:daily-audit:1788661140000:${trigger}`,
          role: "user",
          createdBy: "user",
          text: legacyText,
        }),
      ).toEqual({
        text: "Check for crashes.\n",
        attribution: "automation",
        scheduledTaskId: "task:daily-audit",
      });
    }
  });
});

describe("poteto mode prefix", () => {
  const invocation = "$pstack:poteto-mode";

  it("hides the injected prefix from the user's message", () => {
    const sent = applyPotetoModePrefix("Fix the flaky test", invocation);
    expect(sent).toBe("$pstack:poteto-mode\n\n\u2063Fix the flaky test");
    expect(resolveUserMessagePresentation({ role: "user", text: sent }).text).toBe(
      "Fix the flaky test",
    );
  });

  it("keeps a skill the user typed inline", () => {
    const text = "$pstack:poteto-mode do x";
    expect(resolveUserMessagePresentation({ role: "user", text }).text).toBe(text);
    expect(readPotetoModeInvocation(text)).toBeNull();
  });

  it("keeps a skill the user typed on its own line", () => {
    const text = "$pstack:poteto-mode\n\nFix the flaky test";
    expect(resolveUserMessagePresentation({ role: "user", text }).text).toBe(text);
    expect(readPotetoModeInvocation(text)).toBeNull();
  });

  it("is idempotent so a resend does not stack prefixes", () => {
    const sent = applyPotetoModePrefix("Ship it", invocation);
    expect(applyPotetoModePrefix(sent, invocation)).toBe(sent);
    expect(applyPotetoModePrefix(sent, "/poteto-mode")).toBe(sent);
  });

  it("leaves a leading slash command first", () => {
    expect(applyPotetoModePrefix("/compact", invocation)).toBe("/compact");
    expect(applyPotetoModePrefix("/review the diff", invocation)).toBe("/review the diff");
  });

  it("keeps Claude's ultrathink line on top and visible", () => {
    const sent = applyPotetoModePrefix("Ultrathink:\nRedesign the cache", invocation);
    expect(sent).toBe("Ultrathink:\n$pstack:poteto-mode\n\n\u2063Redesign the cache");
    expect(resolveUserMessagePresentation({ role: "user", text: sent }).text).toBe(
      "Ultrathink:\nRedesign the cache",
    );
    expect(readPotetoModeInvocation(sent)).toBe(invocation);
  });
});
