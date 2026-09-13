import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { DurableRecoveryRecord } from "./types.js";

/**
 * Minimal durable store contract for Phase 20-1.
 *
 * Not a Manager / query engine / transaction layer — just the smallest surface
 * needed to persist a recovery record and the session transcript.
 */
export interface RecoveryStore {
  save(record: DurableRecoveryRecord): Promise<void>;
  load(sessionId: string): Promise<DurableRecoveryRecord | undefined>;
  saveMessages(sessionId: string, messages: AgentMessage[]): Promise<void>;
  loadMessages(sessionId: string): Promise<AgentMessage[] | undefined>;
  /** Phase 34-B — Discovery：返回 store 中所有 Recovery Record（调用方据此发现 unfinished Run）。 */
  list(): Promise<DurableRecoveryRecord[]>;
}
