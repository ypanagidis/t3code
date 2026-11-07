import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { canForwardPorts, formatByteCount, parsePortInput } from "./portForwards";

const environmentId = EnvironmentId.make("env-remote");
const ssh = new SshConnectionTarget({ environmentId, label: "box", connectionId: "ssh-1" });
const bearer = new BearerConnectionTarget({ environmentId, label: "box", connectionId: "b-1" });
const relay = new RelayConnectionTarget({ environmentId, label: "box" });
const primary = new PrimaryConnectionTarget({
  environmentId,
  label: "This machine",
  httpBaseUrl: "http://127.0.0.1:3773",
  wsBaseUrl: "ws://127.0.0.1:3773",
});

const eligible = {
  bridgeSupported: true,
  connected: true,
  canOperateTerminal: true,
  target: ssh,
  capabilities: { tcpPortForwarding: true },
} as const;

describe("canForwardPorts", () => {
  it("allows SSH and direct bearer routes to a capable, connected server", () => {
    expect(canForwardPorts(eligible)).toBe(true);
    expect(canForwardPorts({ ...eligible, target: bearer })).toBe(true);
  });

  it("never forwards through T3 Connect or to this machine", () => {
    expect(canForwardPorts({ ...eligible, target: relay })).toBe(false);
    expect(canForwardPorts({ ...eligible, target: primary })).toBe(false);
  });

  it("needs the desktop bridge, a live connection, terminal access, and a server that advertises it", () => {
    expect(canForwardPorts({ ...eligible, bridgeSupported: false })).toBe(false);
    expect(canForwardPorts({ ...eligible, connected: false })).toBe(false);
    expect(canForwardPorts({ ...eligible, canOperateTerminal: false })).toBe(false);
    expect(canForwardPorts({ ...eligible, target: null })).toBe(false);
    expect(canForwardPorts({ ...eligible, capabilities: {} })).toBe(false);
    expect(canForwardPorts({ ...eligible, capabilities: null })).toBe(false);
  });
});

describe("parsePortInput", () => {
  it("accepts whole ports in range and rejects everything else", () => {
    expect(parsePortInput(" 5173 ")).toBe(5173);
    expect(parsePortInput("65535")).toBe(65535);
    expect(parsePortInput("0")).toBeNull();
    expect(parsePortInput("65536")).toBeNull();
    expect(parsePortInput("80.5")).toBeNull();
    expect(parsePortInput("")).toBeNull();
  });
});

describe("formatByteCount", () => {
  it("scales to the largest whole unit and keeps one decimal below 10", () => {
    expect(formatByteCount(0)).toBe("0 B");
    expect(formatByteCount(1023)).toBe("1023 B");
    expect(formatByteCount(1536)).toBe("1.5 KB");
    expect(formatByteCount(12 * 1024 * 1024)).toBe("12 MB");
    expect(formatByteCount(3 * 1024 ** 5)).toBe("3072 TB");
  });
});
