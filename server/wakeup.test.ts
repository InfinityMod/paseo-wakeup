import assert from "node:assert/strict";
import { test } from "node:test";
import { WakeupScheduler, wakeupPrompt } from "./wakeup.ts";
import {
  Deferred,
  FakeWakeupStorage,
  createWakeupFixture,
  exhaustedQuota,
  initialTime,
  resetQuota,
  scheduleQuotaStop,
} from "./testing/fakes.ts";

test("resumes the same agent once, only after reset plus buffer", async (): Promise<void> => {
  const fixture = await createWakeupFixture();
  await scheduleQuotaStop(fixture);
  assert.equal(fixture.scheduler.snapshot()[0].notBefore, initialTime + 360_000);
  await fixture.scheduler.tick();
  assert.deepEqual(fixture.gateway.prompts, []);
  assert.equal(fixture.gateway.usageReads, 1);
  resetQuota(fixture);
  await fixture.scheduler.tick();
  await fixture.scheduler.tick();
  assert.deepEqual(fixture.gateway.prompts, [{ agentId: "agent-1", prompt: wakeupPrompt }]);
  assert.deepEqual(fixture.storage.saved, []);
});

test("duplicate stopped-turn delivery does not postpone a pending wait", async (): Promise<void> => {
  const fixture = await createWakeupFixture();
  await scheduleQuotaStop(fixture);
  fixture.clock.value += 100_000;
  await scheduleQuotaStop(fixture);
  assert.equal(fixture.scheduler.snapshot().length, 1);
  assert.equal(fixture.storage.writeCount, 1);
});

test("unrelated failures and completed explanations never schedule a continuation", async (): Promise<void> => {
  const fixture = await createWakeupFixture();
  fixture.gateway.quotas = [exhaustedQuota()];
  await fixture.scheduler.stopped({
    agentId: "agent-1",
    providerId: "codex",
    message: "Network connection closed.",
    source: "error",
  });
  await fixture.scheduler.stopped({
    agentId: "agent-1",
    providerId: "codex",
    message: "Implemented the banner saying usage limit reached.",
    source: "output",
  });
  assert.deepEqual(fixture.scheduler.snapshot(), []);
});

test("manual resume and archive cancellation remove the persisted wait", async (): Promise<void> => {
  const fixture = await createWakeupFixture();
  await scheduleQuotaStop(fixture);
  await fixture.scheduler.cancel("agent-1");
  resetQuota(fixture);
  await fixture.scheduler.tick();
  assert.deepEqual(fixture.gateway.prompts, []);
  assert.deepEqual(fixture.storage.saved, []);
});

test("restart restores pending waits and resumes after a new host binding", async (): Promise<void> => {
  const fixture = await createWakeupFixture();
  await scheduleQuotaStop(fixture);
  fixture.scheduler.close();
  resetQuota(fixture);
  const restarted = new WakeupScheduler(fixture.storage, fixture.clock, fixture.logger);
  await restarted.tick();
  assert.deepEqual(fixture.gateway.prompts, []);
  await restarted.attach(fixture.gateway);
  await restarted.tick();
  assert.equal(fixture.gateway.prompts.length, 1);
});

test("manual prompting while the plugin was stopped invalidates a restored wait", async (): Promise<void> => {
  const fixture = await createWakeupFixture();
  await scheduleQuotaStop(fixture);
  fixture.gateway.agents.set("agent-1", {
    providerId: "codex",
    lastUserMessageAt: "2026-10-09T12:02:00Z",
    canResume: true,
  });
  resetQuota(fixture);
  const restarted = new WakeupScheduler(fixture.storage, fixture.clock, fixture.logger);
  await restarted.attach(fixture.gateway);
  await restarted.tick();
  assert.deepEqual(fixture.gateway.prompts, []);
  assert.deepEqual(restarted.snapshot(), []);
});

test("quota still exhausted postpones the wake-up to its new reset", async (): Promise<void> => {
  const fixture = await createWakeupFixture();
  await scheduleQuotaStop(fixture);
  resetQuota(fixture);
  fixture.gateway.quotas = [exhaustedQuota(initialTime + 900_000)];
  await fixture.scheduler.tick();
  assert.equal(fixture.scheduler.snapshot()[0].notBefore, initialTime + 960_000);
  assert.deepEqual(fixture.gateway.prompts, []);
});

test("an exhausted window without reset time stays waiting", async (): Promise<void> => {
  const fixture = await createWakeupFixture();
  fixture.gateway.quotas = [{ ...exhaustedQuota(), windows: [{ usedPct: 100, resetsAt: null }] }];
  await fixture.scheduler.stopped({
    agentId: "agent-1",
    providerId: "codex",
    message: "Usage limit reached.",
    source: "error",
  });
  fixture.clock.value += 86_400_000;
  await fixture.scheduler.tick();
  assert.equal(fixture.scheduler.snapshot()[0].notBefore, null);
  assert.deepEqual(fixture.gateway.prompts, []);
});

test("an explicit reported wait works when provider usage is unavailable", async (): Promise<void> => {
  const fixture = await createWakeupFixture();
  fixture.gateway.usageError = new Error("Quota endpoint offline.");
  await fixture.scheduler.stopped({
    agentId: "agent-1",
    providerId: "codex",
    message: "Usage limit reached. Try again in 2 minutes.",
    source: "error",
  });
  fixture.clock.value += 179_999;
  await fixture.scheduler.tick();
  assert.deepEqual(fixture.gateway.prompts, []);
  fixture.clock.value++;
  await fixture.scheduler.tick();
  assert.equal(fixture.gateway.prompts.length, 1);
});

test("stale healthy quota snapshots do not trigger a resume", async (): Promise<void> => {
  const fixture = await createWakeupFixture();
  await scheduleQuotaStop(fixture);
  resetQuota(fixture);
  fixture.gateway.quotas = [
    {
      providerId: "codex",
      status: "available",
      fetchedAt: new Date(initialTime).toISOString(),
      windows: [{ usedPct: 0 }],
    },
  ];
  await fixture.scheduler.tick();
  assert.deepEqual(fixture.gateway.prompts, []);
  assert.equal(fixture.scheduler.snapshot().length, 1);
});

test("running or permission-blocked agents are left alone", async (): Promise<void> => {
  const fixture = await createWakeupFixture();
  await scheduleQuotaStop(fixture);
  resetQuota(fixture);
  fixture.gateway.agents.set("agent-1", {
    providerId: "codex",
    lastUserMessageAt: "2026-10-09T11:59:00Z",
    canResume: false,
  });
  await fixture.scheduler.tick();
  assert.deepEqual(fixture.gateway.prompts, []);
});

test("missing agents and changed providers discard obsolete waits", async (): Promise<void> => {
  const fixture = await createWakeupFixture();
  await scheduleQuotaStop(fixture);
  resetQuota(fixture);
  fixture.gateway.agents.delete("agent-1");
  await fixture.scheduler.tick();
  assert.deepEqual(fixture.gateway.prompts, []);
  assert.deepEqual(fixture.scheduler.snapshot(), []);
});

test("cancellation during quota I/O prevents an in-flight continuation", async (): Promise<void> => {
  const fixture = await createWakeupFixture();
  await scheduleQuotaStop(fixture);
  resetQuota(fixture);
  fixture.gateway.usageBarrier = new Deferred<void>();
  fixture.gateway.usageStarted = new Deferred<void>();
  const ticking = fixture.scheduler.tick();
  await fixture.gateway.usageStarted.promise;
  await fixture.scheduler.cancel("agent-1");
  fixture.gateway.usageBarrier.resolve();
  await ticking;
  assert.deepEqual(fixture.gateway.prompts, []);
});

test("cancellation during removal persistence prevents an in-flight continuation", async (): Promise<void> => {
  const fixture = await createWakeupFixture();
  await scheduleQuotaStop(fixture);
  resetQuota(fixture);
  fixture.storage.writeBarrier = new Deferred<void>();
  fixture.storage.writeStarted = new Deferred<void>();
  const ticking = fixture.scheduler.tick();
  await fixture.storage.writeStarted.promise;
  await fixture.scheduler.cancel("agent-1");
  fixture.storage.writeBarrier.resolve();
  await ticking;
  assert.deepEqual(fixture.gateway.prompts, []);
});

test("overlapping clock ticks send only one continuation", async (): Promise<void> => {
  const fixture = await createWakeupFixture();
  await scheduleQuotaStop(fixture);
  resetQuota(fixture);
  await Promise.all([fixture.scheduler.tick(), fixture.scheduler.tick()]);
  assert.equal(fixture.gateway.prompts.length, 1);
});

test("plugin cleanup during agent I/O prevents delivery", async (): Promise<void> => {
  const fixture = await createWakeupFixture();
  await scheduleQuotaStop(fixture);
  resetQuota(fixture);
  fixture.gateway.agentBarrier = new Deferred<void>();
  fixture.gateway.agentStarted = new Deferred<void>();
  const ticking = fixture.scheduler.tick();
  await fixture.gateway.agentStarted.promise;
  fixture.scheduler.close();
  fixture.gateway.agentBarrier.resolve();
  await ticking;
  assert.deepEqual(fixture.gateway.prompts, []);
});

test("failed persistence prevents sending and ambiguous send failures are not retried", async (): Promise<void> => {
  const fixture = await createWakeupFixture();
  await scheduleQuotaStop(fixture);
  resetQuota(fixture);
  fixture.storage.writeError = new Error("Disk full.");
  await assert.rejects(fixture.scheduler.tick(), /Disk full/);
  assert.deepEqual(fixture.gateway.prompts, []);
  assert.equal(fixture.scheduler.snapshot().length, 1);
  fixture.storage.writeError = null;
  const restarted = new WakeupScheduler(fixture.storage, fixture.clock, fixture.logger);
  await restarted.attach(fixture.gateway);
  fixture.gateway.sendError = new Error("Acknowledgement lost.");
  await assert.rejects(restarted.tick(), /Acknowledgement lost/);
  await restarted.tick();
  assert.equal(fixture.gateway.prompts.length, 1);
});

test("corrupt storage is preserved and surfaced instead of silently reset", async (): Promise<void> => {
  const storage = new FakeWakeupStorage();
  storage.readError = new Error("Invalid saved queue.");
  await assert.rejects(createWakeupFixture(storage), /Invalid saved queue/);
  assert.equal(storage.writeCount, 0);
});

test("cancellation while a stopped-turn hook reads quota prevents re-arming", async (): Promise<void> => {
  const fixture = await createWakeupFixture();
  fixture.gateway.usageBarrier = new Deferred<void>();
  fixture.gateway.usageStarted = new Deferred<void>();
  const stopping = scheduleQuotaStop(fixture);
  await fixture.gateway.usageStarted.promise;
  await fixture.scheduler.cancel("agent-1");
  fixture.gateway.usageBarrier.resolve();
  await stopping;
  assert.deepEqual(fixture.scheduler.snapshot(), []);
});
