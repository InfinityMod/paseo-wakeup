/** Internal atomic file adapter; only pending wake-ups are saved, never credentials. */
import type * as NodeFiles from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { pendingWakeupSchema, type PendingWakeup } from "../shared/wakeup.ts";
import type { WakeupStorage } from "./wakeup.ts";

export interface WakeupFiles {
  readText(path: string): Promise<string>;
  makeDirectory(path: string): Promise<void>;
  writeText(path: string, text: string): Promise<void>;
  rename(source: string, target: string): Promise<void>;
}

type NodeFileOps = Pick<typeof NodeFiles, "readFile" | "mkdir" | "writeFile" | "rename">;
const savedWakeupsSchema = z.object({
  version: z.literal(1),
  pending: z.array(pendingWakeupSchema),
});

export class NodeWakeupFiles implements WakeupFiles {
  private readonly files: NodeFileOps;

  constructor(files: NodeFileOps) {
    this.files = files;
  }
  readText(path: string): Promise<string> {
    return this.files.readFile(path, "utf8");
  }
  async makeDirectory(path: string): Promise<void> {
    await this.files.mkdir(path, { recursive: true });
  }
  async writeText(path: string, text: string): Promise<void> {
    await this.files.writeFile(path, text, { mode: 0o600 });
  }
  rename(source: string, target: string): Promise<void> {
    return this.files.rename(source, target);
  }
}

export class WakeupFileStorage implements WakeupStorage {
  private writes: Promise<void> = Promise.resolve();
  private readonly path: string;
  private readonly files: WakeupFiles;

  constructor(path: string, files: WakeupFiles) {
    this.path = path;
    this.files = files;
  }

  async read(): Promise<PendingWakeup[]> {
    let text: string;
    try {
      text = await this.files.readText(this.path);
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    return this.parseSavedWakeups(text);
  }

  private parseSavedWakeups(text: string): PendingWakeup[] {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(
        `Invalid wake-up state at ${this.path}: ${text}; expected JSON {version:1,pending:PendingWakeup[]}.`,
      );
    }
    const saved = savedWakeupsSchema.safeParse(value);
    if (!saved.success)
      throw new Error(
        `Invalid wake-up state at ${this.path}: ${text}; expected {version:1,pending:PendingWakeup[]}: ${saved.error.message}`,
      );
    return saved.data.pending;
  }

  write(pending: readonly PendingWakeup[]): Promise<void> {
    const text = JSON.stringify({ version: 1, pending });
    this.writes = this.writes.then(
      () => this.replace(text),
      () => this.replace(text),
    );
    return this.writes;
  }

  flush(): Promise<void> {
    return this.writes;
  }

  private async replace(text: string): Promise<void> {
    await this.files.makeDirectory(dirname(this.path));
    await this.files.writeText(`${this.path}.tmp`, text);
    await this.files.rename(`${this.path}.tmp`, this.path);
  }
}
