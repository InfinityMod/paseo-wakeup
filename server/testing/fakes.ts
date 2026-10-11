import type { PendingWakeup } from "../../shared/wakeup.ts";
import type { ProviderQuota } from "../reset-policy.ts";
import type { WakeupFiles } from "../storage.ts";
import {
  WakeupScheduler,
  type WakeupAgent,
  type WakeupClock,
  type WakeupGateway,
  type WakeupLogger,
  type WakeupStorage,
} from "../wakeup.ts";

export const initialTime = Date.parse("2026-10-09T12:00:00Z");

export class Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve!: (value: Value) => void;
  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }
}

export class FakeWakeupClock implements WakeupClock {
  value = initialTime;
  now(): number {
    return this.value;
  }
}

export class FakeWakeupLogger implements WakeupLogger {
  readonly events: { event: string; fields: Record<string, unknown> }[] = [];
  record(event: string, fields: Record<string, unknown>): void {
    this.events.push({ event, fields });
  }
}

export class FakeWakeupStorage implements WakeupStorage {
  saved: PendingWakeup[] = [];
  writeCount = 0;
  readError: Error | null = null;
  writeError: Error | null = null;
  writeBarrier: Deferred<void> | null = null;
  writeStarted: Deferred<void> | null = null;
  async read(): Promise<PendingWakeup[]> {
    if (this.readError) throw this.readError;
    return this.saved.map((entry) => ({ ...entry }));
  }
  async write(pending: readonly PendingWakeup[]): Promise<void> {
    this.writeStarted?.resolve();
    await this.writeBarrier?.promise;
    if (this.writeError) throw this.writeError;
    this.saved = pending.map((entry) => ({ ...entry }));
    this.writeCount++;
  }
}

export class FakeWakeupGateway implements WakeupGateway {
  quotas: readonly ProviderQuota[] = [];
  readonly agents = new Map<string, WakeupAgent>([
    [
      "agent-1",
      {
        providerId: "codex",
        lastUserMessageAt: "2026-10-09T11:59:00Z",
        canResume: true,
      },
    ],
  ]);
  readonly prompts: { agentId: string; prompt: string }[] = [];
  usageReads = 0;
  usageError: Error | null = null;
  sendError: Error | null = null;
  usageBarrier: Deferred<void> | null = null;
  usageStarted: Deferred<void> | null = null;
  agentBarrier: Deferred<void> | null = null;
  agentStarted: Deferred<void> | null = null;
  async readUsage(): Promise<readonly ProviderQuota[]> {
    this.usageReads++;
    this.usageStarted?.resolve();
    await this.usageBarrier?.promise;
    if (this.usageError) throw this.usageError;
    return this.quotas;
  }
  async readAgent(agentId: string): Promise<WakeupAgent | null> {
    this.agentStarted?.resolve();
    await this.agentBarrier?.promise;
    return this.agents.get(agentId) ?? null;
  }
  async resumeAgent(agentId: string, prompt: string): Promise<void> {
    this.prompts.push({ agentId, prompt });
    if (this.sendError) throw this.sendError;
  }
}

export class FakeWakeupFiles implements WakeupFiles {
  readonly contents = new Map<string, string>();
  readonly renamed: string[] = [];
  writeError: Error | null = null;
  async readText(path: string): Promise<string> {
    const text = this.contents.get(path);
    if (text == null)
      throw Object.assign(new Error(`Missing file ${path}; expected existing state.`), {
        code: "ENOENT",
      });
    return text;
  }
  async makeDirectory(_path: string): Promise<void> {}
  async writeText(path: string, text: string): Promise<void> {
    if (this.writeError) throw this.writeError;
    this.contents.set(path, text);
  }
  async rename(source: string, target: string): Promise<void> {
    this.contents.set(target, await this.readText(source));
    this.contents.delete(source);
    this.renamed.push(target);
  }
}

export interface WakeupFixture {
  scheduler: WakeupScheduler;
  clock: FakeWakeupClock;
  gateway: FakeWakeupGateway;
  storage: FakeWakeupStorage;
  logger: FakeWakeupLogger;
}

export async function createWakeupFixture(
  storage = new FakeWakeupStorage(),
): Promise<WakeupFixture> {
  const clock = new FakeWakeupClock();
  const gateway = new FakeWakeupGateway();
  const logger = new FakeWakeupLogger();
  const scheduler = new WakeupScheduler(storage, clock, logger);
  await scheduler.attach(gateway);
  return { scheduler, clock, gateway, storage, logger };
}

export function exhaustedQuota(resetAt = initialTime + 300_000): ProviderQuota {
  return {
    providerId: "codex",
    status: "available",
    fetchedAt: new Date(initialTime).toISOString(),
    windows: [{ usedPct: 100, resetsAt: new Date(resetAt).toISOString() }],
  };
}

export function availableQuota(fetchedAt: number): ProviderQuota {
  return {
    providerId: "codex",
    status: "available",
    fetchedAt: new Date(fetchedAt).toISOString(),
    windows: [{ remainingPct: 100 }],
  };
}

export async function scheduleQuotaStop(fixture: WakeupFixture): Promise<void> {
  fixture.gateway.quotas = [exhaustedQuota()];
  await fixture.scheduler.stopped({
    agentId: "agent-1",
    providerId: "codex",
    message: "You've hit your usage limit.",
    source: "error",
  });
}

export function resetQuota(fixture: WakeupFixture): void {
  fixture.clock.value += 360_000;
  fixture.gateway.quotas = [availableQuota(fixture.clock.now())];
}
