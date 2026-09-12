import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { RecoveryStore } from "./store.js";
import type { DurableRecoveryRecord } from "./types.js";

/**
 * File-backed RecoveryStore (MVP).
 *
 * Durability guarantee: every write goes through temp-file + atomic rename,
 * so a single recovery record / transcript file is never left half-written even
 * if the process dies mid-write. Production storage (SQLite/Postgres/Redis) is
 * intentionally OUT OF SCOPE for Phase 20-1.
 */
export class FileRecoveryStore implements RecoveryStore {
  constructor(private readonly dir: string) {}

  private safe(name: string): string {
    return name.replace(/[^a-zA-Z0-9._-]/g, "_");
  }

  private recordPath(sessionId: string): string {
    return path.join(this.dir, `recovery-${this.safe(sessionId)}.json`);
  }

  private messagesPath(sessionId: string): string {
    return path.join(this.dir, `messages-${this.safe(sessionId)}.json`);
  }

  private async atomicWrite(file: string, data: unknown): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data), "utf8");
    await fs.rename(tmp, file);
  }

  async save(record: DurableRecoveryRecord): Promise<void> {
    await this.atomicWrite(this.recordPath(record.sessionId), record);
  }

  async load(sessionId: string): Promise<DurableRecoveryRecord | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.recordPath(sessionId), "utf8")) as DurableRecoveryRecord;
    } catch {
      return undefined;
    }
  }

  async saveMessages(sessionId: string, messages: AgentMessage[]): Promise<void> {
    await this.atomicWrite(this.messagesPath(sessionId), messages);
  }

  async loadMessages(sessionId: string): Promise<AgentMessage[] | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.messagesPath(sessionId), "utf8")) as AgentMessage[];
    } catch {
      return undefined;
    }
  }
}
