/** Public client entrypoint: status/cancel UI; scheduling stays on the daemon. */
import type { PluginCleanup } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { WakeupPanel } from "./client/wakeup.tsx";
import { keepWakeupConnected, registerWakeupCommand } from "./client/registration.ts";

/** Add the wake-up panel and command. Example: submit /wakeup cancel in an agent. */
export default function contribute(client: PluginClientContext): PluginCleanup {
  client.addWorkspacePanel({
    id: "wakeup",
    title: "Wake-up",
    icon: "AlarmClock",
    context: "agent",
    Component: WakeupPanel,
  });
  registerWakeupCommand(client);
  return keepWakeupConnected(client);
}
