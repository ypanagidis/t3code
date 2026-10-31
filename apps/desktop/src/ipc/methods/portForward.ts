import {
  DesktopPortForward,
  DesktopPortForwardCredentialInput,
  DesktopPortForwardStartInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopPortForwards from "../../portForward/DesktopPortForwards.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const installPortForwardEventForwarding = Effect.fn(
  "desktop.ipc.portForward.installEventForwarding",
)(function* () {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const portForwards = yield* DesktopPortForwards.DesktopPortForwards;
  yield* portForwards.subscribe((forwards) =>
    electronWindow.sendAll(IpcChannels.PORT_FORWARDS_CHANGED_CHANNEL, forwards),
  );
});

export const startPortForward = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.START_PORT_FORWARD_CHANNEL,
  payload: DesktopPortForwardStartInput,
  result: DesktopPortForward,
  handler: Effect.fn("desktop.ipc.portForward.start")(function* (input) {
    const portForwards = yield* DesktopPortForwards.DesktopPortForwards;
    return yield* portForwards.start(input);
  }),
});

export const stopPortForward = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.STOP_PORT_FORWARD_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.portForward.stop")(function* (forwardId) {
    const portForwards = yield* DesktopPortForwards.DesktopPortForwards;
    yield* portForwards.stop(forwardId);
  }),
});

export const listPortForwards = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.LIST_PORT_FORWARDS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopPortForward),
  handler: Effect.fn("desktop.ipc.portForward.list")(function* () {
    const portForwards = yield* DesktopPortForwards.DesktopPortForwards;
    return yield* portForwards.list;
  }),
});

export const updatePortForwardCredential = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_PORT_FORWARD_CREDENTIAL_CHANNEL,
  payload: DesktopPortForwardCredentialInput,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.portForward.updateCredential")(function* (input) {
    const portForwards = yield* DesktopPortForwards.DesktopPortForwards;
    yield* portForwards.updateCredential(input);
  }),
});
