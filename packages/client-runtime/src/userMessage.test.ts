import { ScheduledTaskId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyPotetoModePrefix,
  readPotetoModeInvocation,
  resolveUserMessagePresentation,
} from "./userMessage.ts";

describe("resolveUserMessagePresentation", () => {
  const legacyText = "[Triggered by schedule task: Daily audit]\n\nCheck for crashes.\n";

  it("removes attribution from legacy scheduled prompts", () => {
    expect(
      resolveUserMessagePresentation({ role: "user", createdBy: "agent", text: legacyText }),
    ).toEqual({ text: "Check for crashes.\n", isAutomation: true, scheduledTaskId: undefined });
  });

  it("uses task metadata without changing the prompt", () => {
    expect(
      resolveUserMessagePresentation({
        role: "user",
        createdBy: "agent",
        scheduledTaskId: ScheduledTaskId.make("task-1"),
        text: legacyText,
      }),
    ).toEqual({ text: legacyText, isAutomation: true, scheduledTaskId: "task-1" });
  });

  it("preserves user-written and assistant-quoted schedule headers", () => {
    for (const message of [
      { role: "user", createdBy: "user" as const },
      { role: "user" },
      { role: "assistant", createdBy: "agent" as const },
    ]) {
      expect(resolveUserMessagePresentation({ ...message, text: legacyText })).toEqual({
        text: legacyText,
        isAutomation: false,
        scheduledTaskId: undefined,
      });
    }
  });

  it("leaves other agent prompts and embedded headers intact", () => {
    for (const text of [
      "Review this area",
      `Quoted prompt:\n${legacyText}`,
      "[Triggered by schedule task: Daily audit]",
    ]) {
      expect(resolveUserMessagePresentation({ role: "user", createdBy: "agent", text })).toEqual({
        text,
        isAutomation: false,
        scheduledTaskId: undefined,
      });
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
        isAutomation: true,
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
