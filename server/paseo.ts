/** Internal adapter: the host owns the SDK connection and provider/session state. */
import type { PaseoApi, PaseoAgentHandle } from "@getpaseo/client";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import type { ProviderQuota } from "./reset-policy.ts";
import type { UsageStoppedTurn, WakeupAgent, WakeupGateway } from "./wakeup.ts";

export interface WakeupSdk {
  providers: Pick<PaseoApi["providers"], "listUsage">;
  agents: { ref(agentId: string): Pick<PaseoAgentHandle, "refresh" | "send"> };
}

export class PaseoWakeupGateway implements WakeupGateway {
  private readonly paseo: WakeupSdk;

  constructor(paseo: WakeupSdk) {
    this.paseo = paseo;
  }

  async readUsage(): Promise<readonly ProviderQuota[]> {
    const usage = await this.paseo.providers.listUsage();
    // Paseo 0.11 stamps the fetch time on the whole list, not on each provider.
    return usage.providers.map((provider) => ({
      ...provider,
      fetchedAt: provider.fetchedAt ?? usage.fetchedAt,
    }));
  }

  async readAgent(agentId: string): Promise<WakeupAgent | null> {
    const result = await this.paseo.agents.ref(agentId).refresh();
    if (!result) return null;
    const agent = result.agent;
    return {
      providerId: agent.provider,
      lastUserMessageAt: agent.lastUserMessageAt,
      canResume:
        !agent.archivedAt &&
        !agent.activeTurn &&
        !agent.providerUnavailable &&
        agent.status !== "running" &&
        agent.status !== "initializing" &&
        agent.pendingPermissions.length === 0,
    };
  }

  resumeAgent(agentId: string, prompt: string): Promise<void> {
    return this.paseo.agents.ref(agentId).send(prompt);
  }
}

export function usageStoppedTurn(
  event: PluginLifecycleEvents["agent.turn_ended"],
): UsageStoppedTurn | null {
  if (event.outcome.kind === "canceled") return null;
  const message =
    event.outcome.kind === "failed"
      ? `${event.outcome.error.code ?? ""}\n${event.outcome.error.message}`
      : latestProviderOutput(event);
  return {
    agentId: event.agent.id,
    providerId: event.agent.provider,
    message,
    source: event.outcome.kind === "failed" ? "error" : "output",
  };
}

function latestProviderOutput(event: PluginLifecycleEvents["agent.turn_ended"]): string {
  const latestUser = event.timeline.findLastIndex((item) => item.type === "user_message");
  const terminal = event.timeline
    .slice(latestUser + 1)
    .findLast((item) => item.type === "assistant_message" || item.type === "error");
  return terminal?.type === "assistant_message"
    ? terminal.text
    : terminal?.type === "error"
      ? terminal.message
      : "";
}
