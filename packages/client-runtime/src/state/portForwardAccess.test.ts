import { describe, expect, it } from "@effect/vitest";

import { portForwardWsBaseUrl } from "./portForwardAccess.ts";

describe("portForwardWsBaseUrl", () => {
  it("maps http to ws and keeps the port", () => {
    expect(portForwardWsBaseUrl("http://127.0.0.1:41234/")).toBe("ws://127.0.0.1:41234");
  });

  it("maps https to wss and drops path, query, and hash", () => {
    expect(portForwardWsBaseUrl("https://box.tail1234.ts.net/t3/?x=1#y")).toBe(
      "wss://box.tail1234.ts.net",
    );
  });
});
