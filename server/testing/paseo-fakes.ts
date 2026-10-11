import type {
  PaseoAgent,
  PaseoAgentRefetchResult,
  PaseoProviderUsageResult,
} from "@getpaseo/client";
import type { PluginCleanup, RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { wakeupRpc } from "../../shared/wakeup.ts";
import type { WakeupSdk } from "../paseo.ts";
import type { WakeupHookContext, WakeupHookName, WakeupRuntime } from "../runtime.ts";
import { initialTime } from "./fakes.ts";

export class FakePaseoAgentHandle {
  private readonly sdk: FakePaseoSdk;
  private readonly agentId: string;
  constructor(sdk: FakePaseoSdk, agentId: string) {
    this.sdk = sdk;
    this.agentId = agentId;
  }
  async refresh(): Promise<PaseoAgentRefetchResult | null> {
    return this.sdk.snapshot ? { agent: this.sdk.snapshot, project: null } : null;
  }
  async send(prompt: string): Promise<void> {
    this.sdk.prompts.push({ agentId: this.agentId, prompt });
  }
}

class FakePaseoAgents {
  private readonly sdk: FakePaseoSdk;
  constructor(sdk: FakePaseoSdk) {
    this.sdk = sdk;
  }
  ref(agentId: string): FakePaseoAgentHandle {
    return new FakePaseoAgentHandle(this.sdk, agentId);
  }
}

class FakePaseoUsage {
  private readonly sdk: FakePaseoSdk;
  constructor(sdk: FakePaseoSdk) {
    this.sdk = sdk;
  }
  async listUsage(): Promise<PaseoProviderUsageResult> {
    return {
      requestId: "usage-test",
      fetchedAt: new Date(this.sdk.fetchedAt).toISOString(),
      providers: this.sdk.quotas,
    };
  }
}

export class FakePaseoSdk implements WakeupSdk {
  readonly agents = new FakePaseoAgents(this);
  readonly providers = new FakePaseoUsage(this);
  readonly prompts: { agentId: string; prompt: string }[] = [];
  quotas: PaseoProviderUsageResult["providers"] = [];
  fetchedAt = initialTime;
  snapshot: PaseoAgent | null = fakePaseoAgent();
}

export function fakePaseoAgent(): PaseoAgent {
  return {
    id: "agent-1",
    provider: "codex",
    cwd: "/project",
    workspaceId: "workspace-1",
    model: "gpt-5.6-sol",
    createdAt: new Date(initialTime).toISOString(),
    updatedAt: new Date(initialTime).toISOString(),
    lastUserMessageAt: "2026-10-09T11:59:00Z",
    status: "error",
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: { provider: "codex", sessionId: "existing-session" },
    title: null,
    labels: {},
    capabilities: fakeAgentCapabilities,
  };
}

const fakeAgentCapabilities: PaseoAgent["capabilities"] = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

export function fakeProviderQuota(
  usedPct: number,
  fetchedAt: number,
  resetAt?: number,
): PaseoProviderUsageResult["providers"][number] {
  const window = {
    id: "primary",
    label: "5h",
    usedPct,
    resetsAt: resetAt == null ? null : new Date(resetAt).toISOString(),
  };
  return {
    providerId: "codex",
    displayName: "Codex",
    planLabel: null,
    status: "available",
    fetchedAt: new Date(fetchedAt).toISOString(),
    windows: [window],
  };
}

/** Shape observed from a 0.11.1 daemon: no per-provider fetchedAt, duplicate IDs, empty credits. */
export function liveShapedUsage(
  providerId: string,
  usedPct: number,
  resetAt: number,
): PaseoProviderUsageResult["providers"] {
  const window = {
    id: "five_hour",
    label: "Session",
    usedPct,
    remainingPct: 100 - usedPct,
    resetsAt: new Date(resetAt).toISOString(),
  };
  return [
    {
      providerId,
      displayName: "Expired login",
      planLabel: null,
      status: "unavailable",
      windows: [],
      balances: [],
      error: "Login expired 26d ago.",
    },
    {
      providerId,
      displayName: "Signed-in account",
      planLabel: "Pro",
      status: "available",
      windows: [window],
      balances: [{ id: "credits", label: "Credits", remaining: 0, unit: "credits" }],
    },
  ];
}

type StoredHook = (
  event: PluginLifecycleEvents[WakeupHookName],
  context: WakeupHookContext,
) => Promise<void>;
type InspectWakeup = (
  input: RpcInput<typeof wakeupRpc>,
  context: WakeupHookContext,
) => Promise<RpcOutput<typeof wakeupRpc>>;

export class FakePaseoPluginRuntime implements WakeupRuntime {
  readonly sdk = new FakePaseoSdk();
  private readonly hooks = new Map<WakeupHookName, StoredHook>();
  private inspect: InspectWakeup | null = null;

  on<Name extends WakeupHookName>(
    name: Name,
    callback: (event: PluginLifecycleEvents[Name], context: WakeupHookContext) => Promise<void>,
  ): PluginCleanup {
    this.hooks.set(name, (event, context) =>
      callback(event as PluginLifecycleEvents[Name], context),
    );
    return (): void => {
      this.hooks.delete(name);
    };
  }
  handle(_contract: typeof wakeupRpc, callback: InspectWakeup): void {
    this.inspect = callback;
  }
  async emit<Name extends WakeupHookName>(
    name: Name,
    event: PluginLifecycleEvents[Name],
  ): Promise<void> {
    await this.hooks.get(name)?.(event, { paseo: this.sdk });
  }
  async request(input: unknown): Promise<RpcOutput<typeof wakeupRpc>> {
    if (!this.inspect)
      throw new Error("Missing wake-up RPC; expected a registered inspection callback.");
    return wakeupRpc.output.parse(
      await this.inspect(wakeupRpc.input.parse(input), { paseo: this.sdk }),
    );
  }
}

export function fakeEndedTurn(provider = "codex"): PluginLifecycleEvents["agent.turn_ended"] {
  return {
    agent: {
      id: "agent-1",
      provider,
      cwd: "/project",
      workspaceId: "workspace-1",
      parentAgentId: null,
      title: null,
    },
    turnId: "turn-1",
    outcome: { kind: "failed", error: { message: "You've hit your usage limit." } },
    timeline: [{ type: "user_message", text: "Finish the task." }],
  };
}
