import assert from "node:assert/strict";
import { test } from "node:test";
import { WakeupFileStorage } from "./storage.ts";
import { FakeWakeupFiles, createWakeupFixture, scheduleQuotaStop } from "./testing/fakes.ts";

test("atomic saved waits round-trip through a new storage instance", async (): Promise<void> => {
  const fixture = await createWakeupFixture();
  await scheduleQuotaStop(fixture);
  const files = new FakeWakeupFiles();
  const storage = new WakeupFileStorage("/test/wakeup.json", files);
  await storage.write(fixture.scheduler.snapshot());
  const restored = new WakeupFileStorage("/test/wakeup.json", files);
  assert.deepEqual(await restored.read(), fixture.scheduler.snapshot());
  assert.deepEqual(files.renamed, ["/test/wakeup.json"]);
  assert.equal(files.contents.has("/test/wakeup.json.tmp"), false);
});

test("a missing queue starts empty", async (): Promise<void> => {
  assert.deepEqual(
    await new WakeupFileStorage("/test/missing.json", new FakeWakeupFiles()).read(),
    [],
  );
});

test("corrupt JSON and unsupported state shapes include offending values", async (): Promise<void> => {
  const files = new FakeWakeupFiles();
  const storage = new WakeupFileStorage("/test/wakeup.json", files);
  files.contents.set("/test/wakeup.json", "bad-json");
  await assert.rejects(storage.read(), /bad-json; expected JSON/);
  files.contents.set("/test/wakeup.json", '{"version":99,"pending":[]}');
  await assert.rejects(storage.read(), /version.*99.*expected/);
  assert.equal(files.contents.get("/test/wakeup.json"), '{"version":99,"pending":[]}');
});

test("concurrent saves are serialized so the latest queue wins", async (): Promise<void> => {
  const fixture = await createWakeupFixture();
  await scheduleQuotaStop(fixture);
  const files = new FakeWakeupFiles();
  const storage = new WakeupFileStorage("/test/wakeup.json", files);
  await Promise.all([storage.write(fixture.scheduler.snapshot()), storage.write([])]);
  await storage.flush();
  assert.deepEqual(await storage.read(), []);
});

test("failed writes preserve the previous file and a later save can recover", async (): Promise<void> => {
  const files = new FakeWakeupFiles();
  const storage = new WakeupFileStorage("/test/wakeup.json", files);
  await storage.write([]);
  files.writeError = new Error("Disk full.");
  await assert.rejects(storage.write([]), /Disk full/);
  assert.deepEqual(await storage.read(), []);
  files.writeError = null;
  await storage.write([]);
  assert.deepEqual(await storage.read(), []);
});
