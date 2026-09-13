import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { makeAuditEvent } from "./event.js";
import type { AuditEvent, AuditSink } from "./event.js";

/**
 * Phase 33-B — append-only 本地文件审计落点（audit.jsonl）。
 *
 * 每行为一个 JSON 审计事件；append-only，不覆盖历史；崩溃安全（同步落盘，
 * 事件一旦 append 返回即已在磁盘上，进程死亡不丢失）。
 * 不复用 TraceCollector、不引入 EventStore / 数据库 / 消息队列 / SIEM。
 */
export class FileAuditSink implements AuditSink {
  constructor(private readonly filePath: string) {}

  append(event: AuditEvent): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, JSON.stringify(event) + "\n", "utf8");
  }
}

export { makeAuditEvent };
