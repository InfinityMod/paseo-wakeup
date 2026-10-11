/** Paseo integration only. WakeupScheduler owns all queue and continuation decisions. */
import type { PluginCleanup, RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { wakeupRpc } from "../shared/wakeup.ts";
import { PaseoWakeupGateway, usageStoppedTurn, type WakeupSdk } from "./paseo.ts";
import type { WakeupLogger, WakeupScheduler } from "./wakeup.ts";

export type WakeupHookName = "agent.turn_started" | "agent.turn_ended" | "agent.archived";
export interface WakeupHookContext {
  paseo: WakeupSdk;
}
export interface WakeupRuntime {
  on<Name extends WakeupHookName>(
    name: Name,
    callback: (event: PluginLifecycleEvents[Name], context: WakeupHookContext) => Promise<void>,
  ): PluginCleanup;
  handle(
    contract: typeof wakeupRpc,
    callback: (
      input: RpcInput<typeof wakeupRpc>,
      context: WakeupHookContext,
    ) => Promise<RpcOutput<typeof wakeupRpc>>,
  ): void;
}

/** Wire the public hooks/RPC. Example: registerWakeupRuntime(server, scheduler). */
export function registerWakeupRuntime(
  server: WakeupRuntime,
  scheduler: WakeupScheduler,
): PluginCleanup {
  const removeEnded = server.on("agent.turn_ended", async (event, { paseo }): Promise<void> => {
    await scheduler.attach(new PaseoWakeupGateway(paseo));
    const turn = usageStoppedTurn(event);
    if (turn) await scheduler.stopped(turn);
  });
  const removeStarted = server.on("agent.turn_started", async (event, { paseo }): Promise<void> => {
    await scheduler.cancel(event.agent.id);
    await scheduler.attach(new PaseoWakeupGateway(paseo));
  });
  const removeArchived = server.on("agent.archived", (event): Promise<void> =>
    scheduler.cancel(event.agent.id),
  );
  registerWakeupInspection(server, scheduler);
  return async (): Promise<void> => {
    await removeEnded();
    await removeStarted();
    await removeArchived();
  };
}

function registerWakeupInspection(server: WakeupRuntime, scheduler: WakeupScheduler): void {
  server.handle(
    wakeupRpc,
    async ({ agentId, action }, { paseo }): Promise<RpcOutput<typeof wakeupRpc>> => {
      if (action === "cancel" && !agentId)
        throw new Error(
          `Invalid cancellation agentId ${String(agentId)}; expected a nonempty agent ID.`,
        );
      if (action === "cancel" && agentId) await scheduler.cancel(agentId);
      await scheduler.attach(new PaseoWakeupGateway(paseo));
      return { pending: scheduler.snapshot(agentId) };
    },
  );
}

/** Own the polling resource and its cleanup. Example: startWakeupPolling(scheduler, logger). */
export function startWakeupPolling(
  scheduler: WakeupScheduler,
  logger: WakeupLogger,
): PluginCleanup {
  const timer = setInterval(() => {
    void scheduler
      .tick()
      .catch((error: unknown) => logger.record("wakeup_check_failed", { error: String(error) }));
  }, 30_000);
  return (): void => {
    clearInterval(timer);
    scheduler.close();
  };
}
