/** Public server entrypoint: hooks and RPC delegate all scheduling to WakeupScheduler. */
import type { PluginCleanup } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import * as files from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { NodeWakeupFiles, WakeupFileStorage } from "./server/storage.ts";
import { WakeupScheduler, type WakeupLogger } from "./server/wakeup.ts";
import { registerWakeupRuntime, startWakeupPolling } from "./server/runtime.ts";

const wakeupLogger: WakeupLogger = {
  record(event, fields): void {
    console.log(JSON.stringify({ event, ...fields }));
  },
};

/** Register automatic wake-ups. Example: Paseo calls contribute(server) on activation. */
export default function contribute(server: PluginServerContext): PluginCleanup {
  const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  const storage = new WakeupFileStorage(
    join(home, "plugin-state", "paseo-wakeup.json"),
    new NodeWakeupFiles(files),
  );
  const scheduler = new WakeupScheduler(storage, { now: Date.now }, wakeupLogger);
  const removeHooks = registerWakeupRuntime(server, scheduler);
  const stopPolling = startWakeupPolling(scheduler, wakeupLogger);
  return async (): Promise<void> => {
    await stopPolling();
    await removeHooks();
    await storage.flush();
  };
}
