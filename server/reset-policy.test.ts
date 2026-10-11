import assert from "node:assert/strict";
import { test } from "node:test";
import { UsageResetPolicy } from "./reset-policy.ts";
import { availableQuota, exhaustedQuota, initialTime } from "./testing/fakes.ts";

const policy = new UsageResetPolicy();
const berlin = new UsageResetPolicy("Europe/Berlin");

test("reset selection respects both short and weekly exhausted windows", (): void => {
  const quota = exhaustedQuota();
  quota.windows = [
    ...quota.windows,
    { remainingPct: 0, resetsAt: "2026-10-12T12:00:00Z" },
    { usedPct: 40, resetsAt: "2026-10-19T12:00:00Z" },
  ];
  assert.deepEqual(policy.assess(quota), {
    state: "exhausted",
    resetAt: Date.parse("2026-10-12T12:00:00Z"),
  });
});

test("one exhausted window with no valid reset prevents a guessed deadline", (): void => {
  const quota = exhaustedQuota();
  quota.windows = [...quota.windows, { remainingPct: 0, resetsAt: null }];
  assert.deepEqual(policy.assess(quota), { state: "exhausted", resetAt: null });
  quota.windows = [{ usedPct: 100, resetsAt: "tomorrow-ish" }];
  assert.equal(policy.assess(quota).resetAt, null);
});

test("exhausted balances participate in reset selection", (): void => {
  const quota = exhaustedQuota();
  quota.balances = [{ used: 20, limit: 20, resetsAt: "2026-10-13T12:00:00Z" }];
  assert.equal(policy.assess(quota).resetAt, Date.parse("2026-10-13T12:00:00Z"));
});

test("quota without numeric utilization is unknown", (): void => {
  assert.deepEqual(
    policy.assess({ providerId: "codex", status: "available", windows: [{ usedPct: null }] }),
    { state: "unknown", resetAt: null },
  );
  assert.equal(policy.assess(undefined).state, "unknown");
});

test("relative provider waits support compound and decimal durations", (): void => {
  assert.equal(
    policy.reportedReset("Try again in 2 hours and 15 minutes.", initialTime),
    initialTime + 8_100_000,
  );
  assert.equal(
    policy.reportedReset("Retry after 1.5 hours.", initialTime),
    initialTime + 5_400_000,
  );
  assert.equal(
    policy.reportedReset("Resets in 2d 3h 4m 5s.", initialTime),
    initialTime + 183_845_000,
  );
  assert.equal(policy.reportedReset("Retry in 1h30m.", initialTime), initialTime + 5_400_000);
});

test("unsupported units, unknown zones, and bare mentions are not guessed", (): void => {
  assert.equal(policy.reportedReset("Resets at 6pm (Mars/Olympus)", initialTime), null);
  assert.equal(policy.reportedReset("Try again in 5 milliseconds.", initialTime), null);
  assert.equal(policy.reportedReset("Try again in 0 minutes.", initialTime), null);
  assert.equal(policy.reportedReset("The limit resets soon.", initialTime), null);
});

test("clock resets resolve in the reported zone, else the local zone", (): void => {
  const claude = "You've hit your session limit · resets 2:20am (Europe/Berlin)";
  assert.equal(berlin.reportedReset(claude, initialTime), Date.parse("2026-10-10T00:20:00Z"));
  assert.equal(
    berlin.reportedReset("resets 6pm (Europe/Zurich)", initialTime),
    Date.parse("2026-10-09T16:00:00Z"),
  );
  assert.equal(
    berlin.reportedReset("resets 3pm (America/New_York)", initialTime),
    Date.parse("2026-10-09T19:00:00Z"),
  );
  const codex =
    "You\u2019ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 14th, 2026 9:36 AM.";
  assert.equal(berlin.reportedReset(codex, initialTime), Date.parse("2026-10-14T07:36:00Z"));
  assert.equal(
    berlin.reportedReset("try again at 9:36 AM.", initialTime),
    Date.parse("2026-10-10T07:36:00Z"),
  );
  assert.equal(
    berlin.reportedReset("try again at Nov 2nd, 2026 9:00 AM.", initialTime),
    Date.parse("2026-11-02T08:00:00Z"),
  );
});

test("a clock reset that just passed is not pushed to the next day", (): void => {
  assert.equal(
    berlin.reportedReset("resets 1:58pm (Europe/Berlin)", initialTime),
    Date.parse("2026-10-09T11:58:00Z"),
  );
});

test("observed provider stop banners are recognized", (): void => {
  for (const banner of [
    "You've hit your session limit · resets 2:20am (Europe/Berlin)",
    "You\u2019ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 14th, 2026 9:36 AM.",
    "You've hit your usage limit for GPT-5.3-Codex-Spark. Switch to another model now, or try again at Sep 13th, 2026 3:34 AM.",
  ])
    assert.equal(policy.isUsageStop(banner, "output"), true, banner);
  for (const failure of [
    '403 {"error":{"type":"permission_error","message":"You\'ve reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends."}}',
    "Codex error: The usage limit has been reached (stopReason=error, model=openai-codex/gpt-5.3-codex-spark)",
  ])
    assert.equal(policy.isUsageStop(failure, "error"), true, failure);
});

test("an empty prepaid balance does not hide a plan window reset", (): void => {
  const quota = exhaustedQuota();
  quota.balances = [{ remaining: 0 }];
  assert.deepEqual(policy.assess(quota), { state: "exhausted", resetAt: initialTime + 300_000 });
  assert.equal(
    policy.assess({ ...availableQuota(initialTime), balances: [{ remaining: 0 }] }).state,
    "available",
  );
  assert.deepEqual(
    policy.assess({
      providerId: "openrouter",
      status: "available",
      windows: [],
      balances: [{ remaining: 0 }],
    }),
    { state: "exhausted", resetAt: null },
  );
});

test("normal output mentioning usage limits is not a quota-stop banner", (): void => {
  assert.equal(policy.isUsageStop("I fixed the usage limit reached banner.", "output"), false);
  assert.equal(policy.isUsageStop("You've hit your limit · resets 6pm", "output"), true);
  assert.equal(policy.isUsageStop("Provider failed: rate_limit_exceeded", "error"), true);
  assert.equal(policy.isUsageStop("Context window full", "error"), false);
});
