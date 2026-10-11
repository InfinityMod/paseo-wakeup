import assert from "node:assert/strict";
import { test } from "node:test";
import { PaseoWakeupGateway, usageStoppedTurn } from "./paseo.ts";
import { registerWakeupRuntime } from "./runtime.ts";
import { createWakeupFixture, initialTime } from "./testing/fakes.ts";
import {
  FakePaseoPluginRuntime,
  FakePaseoSdk,
  fakeEndedTurn,
  fakeProviderQuota,
  liveShapedUsage,
} from "./testing/paseo-fakes.ts";

const claudeBanner = "You've hit your session limit · resets 2:20am (Europe/Berlin)";
const codexBanner =
  "You\u2019ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 14th, 2026 9:36 AM.";

test("plugin hooks and RPC schedule a continuation through the existing SDK agent", async (): Promise<void> => {
  const fixture = await createWakeupFixture();
  const runtime = new FakePaseoPluginRuntime();
  const cleanup = registerWakeupRuntime(runtime, fixture.scheduler);
  runtime.sdk.quotas = [fakeProviderQuota(100, initialTime, initialTime + 300_000)];
  await runtime.emit("agent.turn_ended", fakeEndedTurn());
  assert.equal((await runtime.request({ agentId: "agent-1" })).pending.length, 1);
  fixture.clock.value += 360_000;
  runtime.sdk.quotas = [fakeProviderQuota(0, fixture.clock.now())];
  await fixture.scheduler.tick();
  assert.equal(runtime.sdk.prompts[0].agentId, "agent-1");
  assert.deepEqual((await runtime.request({ agentId: "agent-1" })).pending, []);
  await cleanup();
});

test("native SDK snapshot gates archived, running, and missing agents", async (): Promise<void> => {
  const sdk = new FakePaseoSdk();
  const gateway = new PaseoWakeupGateway(sdk);
  assert.equal((await gateway.readAgent("agent-1"))?.canResume, true);
  assert(sdk.snapshot);
  sdk.snapshot.archivedAt = new Date(initialTime).toISOString();
  assert.equal((await gateway.readAgent("agent-1"))?.canResume, false);
  sdk.snapshot.archivedAt = null;
  sdk.snapshot.status = "running";
  assert.equal((await gateway.readAgent("agent-1"))?.canResume, false);
  sdk.snapshot = null;
  assert.equal(await gateway.readAgent("agent-1"), null);
});

test("native SDK snapshot never resumes through a pending permission request", async (): Promise<void> => {
  const sdk = new FakePaseoSdk();
  assert(sdk.snapshot);
  sdk.snapshot.pendingPermissions = [
    { id: "permission-1", provider: "codex", name: "shell", kind: "tool" },
  ];
  assert.equal((await new PaseoWakeupGateway(sdk).readAgent("agent-1"))?.canResume, false);
});

test("the latest user turn prevents old usage errors from being replayed", (): void => {
  const ended = fakeEndedTurn();
  ended.outcome = { kind: "completed" };
  ended.timeline = [
    { type: "error", message: "Usage limit reached." },
    { type: "user_message", text: "Continue." },
    { type: "assistant_message", text: "Task complete." },
  ];
  assert.equal(usageStoppedTurn(ended)?.message, "Task complete.");
  ended.outcome = { kind: "canceled", reason: "User stopped the turn." };
  assert.equal(usageStoppedTurn(ended), null);
});

test("public cancellation validates agent ID and lifecycle cancellation removes the queue", async (): Promise<void> => {
  const fixture = await createWakeupFixture();
  const runtime = new FakePaseoPluginRuntime();
  const cleanup = registerWakeupRuntime(runtime, fixture.scheduler);
  runtime.sdk.quotas = [];
  await runtime.emit("agent.turn_ended", fakeEndedTurn());
  await assert.rejects(
    runtime.request({ action: "cancel" }),
    /undefined; expected a nonempty agent ID/,
  );
  await assert.rejects(runtime.request({ action: "erase" }), /Invalid option/);
  await runtime.emit("agent.turn_started", { agent: fakeEndedTurn().agent, turnId: "manual-turn" });
  assert.deepEqual((await runtime.request({ agentId: "agent-1" })).pending, []);
  await runtime.emit("agent.turn_ended", fakeEndedTurn());
  await runtime.request({ agentId: "agent-1", action: "cancel" });
  assert.deepEqual(fixture.storage.saved, []);
  await cleanup();
});

test("a Claude session-limit banner resumes at its reported reset despite a stale quota", async (): Promise<void> => {
  const fixture = await createWakeupFixture();
  const runtime = new FakePaseoPluginRuntime();
  const cleanup = registerWakeupRuntime(runtime, fixture.scheduler);
  const reset = Date.parse("2026-10-10T00:20:00Z");
  assert(runtime.sdk.snapshot);
  runtime.sdk.snapshot.provider = "claude";
  runtime.sdk.quotas = liveShapedUsage("claude", 97, reset);
  const ended = fakeEndedTurn("claude");
  ended.outcome = { kind: "completed" };
  ended.timeline = [
    { type: "user_message", text: "Finish the task." },
    { type: "assistant_message", text: claudeBanner },
  ];
  await runtime.emit("agent.turn_ended", ended);
  assert.equal(
    (await runtime.request({ agentId: "agent-1" })).pending[0]?.notBefore,
    reset + 60_000,
  );
  fixture.clock.value = reset + 61_000;
  runtime.sdk.fetchedAt = fixture.clock.now();
  runtime.sdk.quotas = liveShapedUsage("claude", 0, reset + 18_000_000);
  await fixture.scheduler.tick();
  assert.deepEqual(
    runtime.sdk.prompts.map((sent) => sent.agentId),
    ["agent-1"],
  );
  await cleanup();
});

test("a Codex weekly stop waits for the plan window, not the empty credit balance", async (): Promise<void> => {
  const fixture = await createWakeupFixture();
  const runtime = new FakePaseoPluginRuntime();
  const cleanup = registerWakeupRuntime(runtime, fixture.scheduler);
  const reset = Date.parse("2026-10-15T11:52:11Z");
  runtime.sdk.quotas = liveShapedUsage("codex", 100, reset);
  const ended = fakeEndedTurn();
  ended.outcome = { kind: "failed", error: { message: codexBanner } };
  await runtime.emit("agent.turn_ended", ended);
  assert.equal(
    (await runtime.request({ agentId: "agent-1" })).pending[0]?.notBefore,
    reset + 60_000,
  );
  fixture.clock.value = reset + 61_000;
  await fixture.scheduler.tick();
  assert.equal(runtime.sdk.prompts.length, 0);
  runtime.sdk.fetchedAt = fixture.clock.now();
  runtime.sdk.quotas = liveShapedUsage("codex", 0, reset + 604_800_000);
  fixture.clock.value += 60_000;
  await fixture.scheduler.tick();
  assert.deepEqual(
    runtime.sdk.prompts.map((sent) => sent.agentId),
    ["agent-1"],
  );
  await cleanup();
});
