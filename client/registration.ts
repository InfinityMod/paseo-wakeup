/** Client registration only; the daemon owns detection and wake-up timing. */
import type { PluginCleanup } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { wakeupRpc } from "../shared/wakeup.ts";

/** Register inspection/cancellation. Example: registerWakeupCommand(client). */
export function registerWakeupCommand(client: PluginClientContext): void {
  client.addSlashCommand({
    name: "wakeup",
    description: "Inspect or cancel automatic quota wake-up",
    argumentHint: "[cancel]",
    context: "agent",
    async onSubmit({ args, agent, rpc, openPanel }): Promise<void> {
      if (args && args !== "cancel")
        throw new Error(
          `Invalid /wakeup argument ${JSON.stringify(args)}; expected empty or "cancel".`,
        );
      await rpc(wakeupRpc, { agentId: agent.id, action: args === "cancel" ? "cancel" : "status" });
      openPanel("wakeup");
    },
  });
}

/** Rebind a restored queue to the host SDK. Example: keepWakeupConnected(client). */
export function keepWakeupConnected(client: PluginClientContext): PluginCleanup {
  // ponytail: A reload needs one client RPC or lifecycle event to rebind Paseo's hook-only server SDK.
  const reconnect = (): void => {
    void client
      .rpc(wakeupRpc, { action: "status" })
      .catch((error: unknown) =>
        console.error(JSON.stringify({ event: "wakeup_reconnect_failed", error: String(error) })),
      );
  };
  reconnect();
  const timer = setInterval(reconnect, 30_000);
  return (): void => {
    clearInterval(timer);
  };
}
