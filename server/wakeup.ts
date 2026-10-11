/** Scheduling owner. Other modules call WakeupScheduler; its queue stays private. */
import type { PendingWakeup } from "../shared/wakeup.ts";
import { resetBufferMs, UsageResetPolicy, type ProviderQuota } from "./reset-policy.ts";

export interface WakeupAgent {
  providerId: string;
  lastUserMessageAt: string | null;
  canResume: boolean;
}

export interface WakeupGateway {
  readUsage(): Promise<readonly ProviderQuota[]>;
  readAgent(agentId: string): Promise<WakeupAgent | null>;
  resumeAgent(agentId: string, prompt: string): Promise<void>;
}

export interface WakeupStorage {
  read(): Promise<PendingWakeup[]>;
  write(pending: readonly PendingWakeup[]): Promise<void>;
}

export interface WakeupClock {
  now(): number;
}
export interface WakeupLogger {
  record(event: string, fields: Record<string, unknown>): void;
}
export interface UsageStoppedTurn {
  agentId: string;
  providerId: string;
  message: string;
  source: "error" | "output";
}

export const wakeupPrompt =
  "Your previous turn was interrupted by a provider usage limit. Continue the existing task from where you stopped, preserving completed work and the user's instructions. If the task is already complete, do not restart it.";

/** Resumes interrupted sessions once quota resets. Example: scheduler.stopped(turn). */
export class WakeupScheduler {
  private readonly pending = new Map<string, PendingWakeup>();
  private readonly generations = new Map<string, number>();
  private readonly policy = new UsageResetPolicy();
  private readonly ready: Promise<void>;
  private gateway: WakeupGateway | null = null;
  private ticking = false;
  private disposed = false;
  private readonly storage: WakeupStorage;
  private readonly clock: WakeupClock;
  private readonly logger: WakeupLogger;

  constructor(storage: WakeupStorage, clock: WakeupClock, logger: WakeupLogger) {
    this.storage = storage;
    this.clock = clock;
    this.logger = logger;
    this.ready = this.restore();
    void this.ready.catch((error: unknown) => this.failure("restore_failed", error));
  }

  /** Bind the host-owned SDK after a hook or RPC. Example: await scheduler.attach(gateway). */
  async attach(gateway: WakeupGateway): Promise<void> {
    await this.ready;
    if (!this.disposed) this.gateway = gateway;
  }

  /** Record a usage stop without replaying the original prompt. Example: await scheduler.stopped(turn). */
  async stopped(turn: UsageStoppedTurn): Promise<void> {
    const generation = this.generations.get(turn.agentId);
    await this.ready;
    if (!this.gateway || this.disposed) return;
    if (!this.policy.isUsageStop(turn.message, turn.source)) return this.unrecognized(turn);
    const agent = await this.gateway.readAgent(turn.agentId);
    if (!agent?.canResume || agent.providerId !== turn.providerId)
      return this.skipped(turn.agentId, "agent_not_resumable");
    const quota = this.policy.select(await this.readQuotas(this.gateway), turn.providerId);
    if (this.disposed || this.generations.get(turn.agentId) !== generation) return;
    await this.remember(turn, agent, quota);
  }

  /** Cancel pending work, including in-flight quota checks. Example: await scheduler.cancel(id). */
  async cancel(agentId: string): Promise<void> {
    this.generations.set(agentId, (this.generations.get(agentId) ?? 0) + 1);
    await this.ready;
    if (this.disposed) return;
    if (!this.pending.delete(agentId)) return;
    await this.persist();
    this.logger.record("wakeup_cancelled", { agentId });
  }

  /** Read pending waits for display. Example: scheduler.snapshot(agentId). */
  snapshot(agentId?: string): PendingWakeup[] {
    return [...this.pending.values()]
      .filter((entry) => !agentId || entry.agentId === agentId)
      .map((entry) => ({ ...entry }));
  }

  /** Check due waits with the latest public quota snapshot. Example: await scheduler.tick(). */
  async tick(): Promise<void> {
    await this.ready;
    if (!this.gateway || this.disposed || this.ticking || !this.pending.size) return;
    const due = this.snapshot().filter(
      (entry) => entry.notBefore == null || entry.notBefore <= this.clock.now(),
    );
    if (!due.length) return;
    this.ticking = true;
    try {
      const gateway = this.gateway;
      const quotas = await this.readQuotas(gateway);
      for (const entry of [...this.pending.values()].filter(
        (entry) => entry.notBefore == null || entry.notBefore <= this.clock.now(),
      ))
        await this.check(entry, quotas, gateway);
    } finally {
      this.ticking = false;
    }
  }

  /** Stop timers from using this queue after teardown. Example: scheduler.close(). */
  close(): void {
    this.disposed = true;
    this.gateway = null;
  }

  private async restore(): Promise<void> {
    for (const entry of await this.storage.read()) this.pending.set(entry.agentId, entry);
  }

  private async remember(
    turn: UsageStoppedTurn,
    agent: WakeupAgent,
    quota: ProviderQuota | undefined,
  ): Promise<void> {
    const now = this.clock.now();
    const assessment = this.policy.assess(quota);
    const reportedReset = this.policy.reportedReset(turn.message, now);
    if (assessment.state === "available" && !reportedReset)
      return this.skipped(turn.agentId, "quota_available_without_reported_reset");
    const reset = assessment.resetAt ?? reportedReset;
    const previous = this.pending.get(turn.agentId);
    if (previous?.lastUserMessageAt === agent.lastUserMessageAt) return;
    const entry = this.buildQuotaWait(turn, agent, now, reset, reportedReset);
    this.pending.set(turn.agentId, entry);
    await this.persist();
    this.logger.record("wakeup_scheduled", {
      agentId: entry.agentId,
      resumeAfter: entry.notBefore == null ? null : new Date(entry.notBefore).toISOString(),
    });
  }

  private buildQuotaWait(
    turn: UsageStoppedTurn,
    agent: WakeupAgent,
    now: number,
    reset: number | null,
    reportedReset: number | null,
  ): PendingWakeup {
    return {
      agentId: turn.agentId,
      providerId: turn.providerId,
      lastUserMessageAt: agent.lastUserMessageAt,
      stoppedAt: now,
      notBefore: reset == null ? null : Math.max(now, reset) + resetBufferMs,
      reportedReset,
      reason:
        reset == null
          ? "Waiting for the provider to report a reset time."
          : "Waiting for the provider usage limit to reset.",
    };
  }

  private async check(
    entry: PendingWakeup,
    quotas: readonly ProviderQuota[],
    gateway: WakeupGateway,
  ): Promise<void> {
    if (!this.isCurrent(entry) || (entry.notBefore != null && entry.notBefore > this.clock.now()))
      return;
    const quota = this.policy.select(quotas, entry.providerId);
    const assessment = this.policy.assess(quota);
    if (assessment.state === "exhausted") return this.defer(entry, assessment.resetAt);
    if (!this.quotaAllowsResume(entry, quota, assessment.state)) return;
    const agent = await gateway.readAgent(entry.agentId);
    if (!this.isCurrent(entry)) return;
    if (
      !agent ||
      agent.providerId !== entry.providerId ||
      agent.lastUserMessageAt !== entry.lastUserMessageAt
    )
      return this.cancel(entry.agentId);
    if (!agent.canResume) return;
    await this.deliver(entry, gateway);
  }

  private quotaAllowsResume(
    entry: PendingWakeup,
    quota: ProviderQuota | undefined,
    state: "available" | "unknown",
  ): boolean {
    if (state === "unknown")
      return entry.reportedReset != null && entry.reportedReset + resetBufferMs <= this.clock.now();
    const fetchedAt = Date.parse(quota?.fetchedAt ?? "");
    const minimum = entry.notBefore == null ? entry.stoppedAt : entry.notBefore - resetBufferMs;
    return Number.isFinite(fetchedAt) && fetchedAt >= minimum;
  }

  private async defer(entry: PendingWakeup, resetAt: number | null): Promise<void> {
    const notBefore = resetAt == null ? null : Math.max(this.clock.now(), resetAt) + resetBufferMs;
    if (entry.notBefore === notBefore) return;
    this.pending.set(entry.agentId, { ...entry, notBefore });
    await this.persist();
  }

  private async deliver(entry: PendingWakeup, gateway: WakeupGateway): Promise<void> {
    const generation = this.generations.get(entry.agentId);
    this.pending.delete(entry.agentId);
    try {
      await this.persist();
    } catch (error: unknown) {
      if (!this.disposed && this.generations.get(entry.agentId) === generation)
        this.pending.set(entry.agentId, entry);
      throw error;
    }
    if (this.disposed || this.generations.get(entry.agentId) !== generation) return;
    // Removing the saved wait before sending avoids duplicate continuations after an ambiguous acknowledgement.
    await gateway.resumeAgent(entry.agentId, wakeupPrompt);
    this.logger.record("wakeup_sent", { agentId: entry.agentId });
  }

  private isCurrent(entry: PendingWakeup): boolean {
    return !this.disposed && this.pending.get(entry.agentId) === entry;
  }

  private persist(): Promise<void> {
    return this.storage.write(this.snapshot());
  }

  private async readQuotas(gateway: WakeupGateway): Promise<readonly ProviderQuota[]> {
    try {
      return await gateway.readUsage();
    } catch (error: unknown) {
      this.failure("quota_read_failed", error);
      return [];
    }
  }

  /** Keep the provider's wording so an unmatched limit banner can be diagnosed from the log. */
  private unrecognized(turn: UsageStoppedTurn): void {
    if (turn.source !== "error") return;
    this.logger.record("failure_not_usage_stop", {
      agentId: turn.agentId,
      message: turn.message.trim().slice(0, 160),
    });
  }

  private skipped(agentId: string, reason: string): void {
    this.logger.record("wakeup_skipped", { agentId, reason });
  }

  private failure(event: string, error: unknown): void {
    this.logger.record(event, { error: String(error) });
  }
}
