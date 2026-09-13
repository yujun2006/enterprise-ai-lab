/**
 * Phase 37-B Acceptance — Human-Gated Recovery Extension（真实进程崩溃 + 真实持久化）。
 *
 * 验证 Phase 37-A 结论：Human Approval 不是新 Runtime Boundary，而是
 *   Policy ASK + Durable Pending Operation（复用 DurableRecoveryRecord / RecoveryStore / Recovery）。
 *
 * 覆盖：正常 / crash while pending / restart pending / approve after restart / reject after restart /
 *       approve + crash before tool / external commit crash（回归）/ 重复 Approve / Approve-Reject 竞态 / 跨 Run 隔离。
 *
 * 运行：npm run acceptance:phase37b
 */
import { mkdtemp } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { EnterpriseAiRuntime, FileRecoveryStore, FileAuditSink } from "../src/index.js";
import type { Policy, PolicyOutcome, ReconcileFn } from "../src/index.js";
import { ScriptedModel, ExternalResource, makeCommitTool, reconcileFileExternal } from "./_p20_fixtures.js";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`[${cond ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
}

function runChild(env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", path.resolve("scripts/_p37b_child.ts")], {
      env: { ...process.env, ...env },
      stdio: "ignore",
    });
    child.on("exit", (code) => resolve(code ?? -1));
  });
}

async function waitFor(fn: () => Promise<boolean>, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor timeout");
}

async function readAudit(p: string): Promise<any[]> {
  try {
    return (await fs.readFile(p, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function buildRuntime(opts: {
  sessionId: string;
  store: FileRecoveryStore;
  audit?: FileAuditSink;
  model: ScriptedModel;
  dir: string;
  policy: Policy;
}) {
  return new EnterpriseAiRuntime({
    sessionId: opts.sessionId,
    store: opts.store,
    audit: opts.audit,
    policy: opts.policy,
    model: opts.model.model,
    streamFn: opts.model.streamFn,
    tools: [makeCommitTool(new ExternalResource(path.join(opts.dir, "external.json")), "none")],
  });
}

const askNever: Policy = (ctx) =>
  ctx.toolName === "commit_record" ? { type: "ask", approval: () => new Promise<PolicyOutcome>(() => {}) } : { type: "allow" };

async function main(): Promise<void> {
  // ============ A — Normal：ASK → approve → Tool execute once ============
  {
    const dir = await mkdtemp(path.join(os.tmpdir(), "p37b-A-"));
    const key = "op-A";
    const sess = "sess-A";
    const store = new FileRecoveryStore(dir);
    const auditFile = path.join(dir, "audit.jsonl");
    const audit = new FileAuditSink(auditFile);
    const policy: Policy = (ctx) =>
      ctx.toolName === "commit_record" ? { type: "ask", approval: () => Promise.resolve("allow") } : { type: "allow" };
    const model = new ScriptedModel();
    model.enqueueTool({ name: "commit_record", arguments: { idempotencyKey: key } });
    model.enqueueFinal("done");
    const rt = buildRuntime({ sessionId: sess, store, audit, model, dir, policy });
    const res = await rt.run("commit");
    await rt.waitForIdle();
    check("A run completed", res.status === "completed", res.status);
    check("A tool executed exactly once", (await new ExternalResource(path.join(dir, "external.json")).commitCount()) === 1);
    const rec = await store.load(sess);
    check("A durable status recovered (approved→executed)", rec?.status === "recovered", String(rec?.status));
    check("A approvalId durable", !!rec?.approvalId);
    const evts = await readAudit(auditFile);
    check("A audit APPROVAL_DECISION PENDING present", evts.some((e) => e.eventType === "APPROVAL_DECISION" && e.approvalDecision === "PENDING"));
    check("A audit APPROVAL_DECISION APPROVED present", evts.some((e) => e.eventType === "APPROVAL_DECISION" && e.approvalDecision === "APPROVED"));
    check("A NO secret in audit", !JSON.stringify(evts).includes("super-secret"));
  }

  // ============ B — Crash while pending：approval 不丢失，可被发现 ============
  {
    const dir = await mkdtemp(path.join(os.tmpdir(), "p37b-B-"));
    const key = "op-B";
    const sess = "sess-B";
    const code = await runChild({ P37_DIR: dir, P37_SESSION: sess, P37_KEY: key, P37_POLICY: "ask", P37_APPROVE: "never", P37_TOOL: "none", P37_EXIT: "137" });
    check("B child exited 137 (death while pending)", code === 137, `code=${code}`);
    const store = new FileRecoveryStore(dir);
    const rec = await store.load(sess);
    check("B pending approval persisted", rec?.status === "pending_approval", String(rec?.status));
    check("B approvalId present & durable", !!rec?.approvalId, String(rec?.approvalId));
    const all = await store.list();
    check("B discovered via store.list", all.some((r) => r.sessionId === sess && r.status === "pending_approval"));
    const ext = new ExternalResource(path.join(dir, "external.json"));
    const model = new ScriptedModel();
    const rt = buildRuntime({ sessionId: sess, store, model, dir, policy: askNever });
    const rr = await rt.recoverIfUnfinished(reconcileFileExternal(ext));
    check("B recovery does NOT auto-execute (continue)", rr.decision === "continue", rr.decision);
    check("B external side effect == 0 (no auto-tool)", (await ext.commitCount()) === 0, `count=${await ext.commitCount()}`);
  }

  // ============ C — Restart while still pending, no human：不得自动执行，保持 pending ============
  {
    const dir = await mkdtemp(path.join(os.tmpdir(), "p37b-C-"));
    const key = "op-C";
    const sess = "sess-C";
    await runChild({ P37_DIR: dir, P37_SESSION: sess, P37_KEY: key, P37_POLICY: "ask", P37_APPROVE: "never", P37_TOOL: "none", P37_EXIT: "137" });
    const store = new FileRecoveryStore(dir);
    const ext = new ExternalResource(path.join(dir, "external.json"));
    const model = new ScriptedModel();
    model.enqueueTool({ name: "commit_record", arguments: { idempotencyKey: key } });
    model.enqueueFinal("done");
    const rt = buildRuntime({ sessionId: sess, store, model, dir, policy: askNever });
    const runP = rt.run("resume"); // 不 await：人工未决议，会卡在 await
    await waitFor(async () => (await store.load(sess))?.status === "pending_approval");
    await new Promise((r) => setTimeout(r, 300)); // 给足时间确认不自动执行
    const rec = await store.load(sess);
    check("C still pending_approval (no auto-tool)", rec?.status === "pending_approval", String(rec?.status));
    check("C external side effect == 0", (await ext.commitCount()) === 0, `count=${await ext.commitCount()}`);
    void runP;
  }

  // ============ D — Approve after restart：approval 恢复后 Tool 执行一次 ============
  {
    const dir = await mkdtemp(path.join(os.tmpdir(), "p37b-D-"));
    const key = "op-D";
    const sess = "sess-D";
    await runChild({ P37_DIR: dir, P37_SESSION: sess, P37_KEY: key, P37_POLICY: "ask", P37_APPROVE: "never", P37_TOOL: "none", P37_EXIT: "137" });
    const store = new FileRecoveryStore(dir);
    const ext = new ExternalResource(path.join(dir, "external.json"));
    const model = new ScriptedModel();
    model.enqueueTool({ name: "commit_record", arguments: { idempotencyKey: key } });
    model.enqueueFinal("done");
    const rt = buildRuntime({ sessionId: sess, store, model, dir, policy: askNever });
    const aid = (await store.load(sess))!.approvalId!;
    const runP = rt.run("resume");
    await waitFor(async () => (await store.load(sess))?.status === "pending_approval");
    await rt.applyDecision(aid, "allow");
    await runP;
    await rt.waitForIdle();
    check("D tool executed exactly once", (await ext.commitCount()) === 1, `count=${await ext.commitCount()}`);
    const rec = await store.load(sess);
    check("D durable status recovered (approved→executed)", rec?.status === "recovered", String(rec?.status));
  }

  // ============ E — Reject after restart：Tool 永不执行 ============
  {
    const dir = await mkdtemp(path.join(os.tmpdir(), "p37b-E-"));
    const key = "op-E";
    const sess = "sess-E";
    await runChild({ P37_DIR: dir, P37_SESSION: sess, P37_KEY: key, P37_POLICY: "ask", P37_APPROVE: "never", P37_TOOL: "none", P37_EXIT: "137" });
    const store = new FileRecoveryStore(dir);
    const ext = new ExternalResource(path.join(dir, "external.json"));
    const model = new ScriptedModel();
    model.enqueueTool({ name: "commit_record", arguments: { idempotencyKey: key } });
    model.enqueueFinal("done");
    const rt = buildRuntime({ sessionId: sess, store, model, dir, policy: askNever });
    const aid = (await store.load(sess))!.approvalId!;
    const runP = rt.run("resume");
    await waitFor(async () => (await store.load(sess))?.status === "pending_approval");
    await rt.applyDecision(aid, "deny");
    await runP;
    await rt.waitForIdle();
    check("E tool NOT executed", (await ext.commitCount()) === 0, `count=${await ext.commitCount()}`);
    const rec = await store.load(sess);
    check("E durable status rejected", rec?.status === "rejected", String(rec?.status));
  }

  // ============ F — Approve + crash before tool → resume，副作用至多一次 ============
  {
    const dir = await mkdtemp(path.join(os.tmpdir(), "p37b-F-"));
    const key = "op-F";
    const sess = "sess-F";
    // child：approval 解析 allow（pending→approved），tool 在 commit 前崩溃（precommit-exit）
    const code = await runChild({ P37_DIR: dir, P37_SESSION: sess, P37_KEY: key, P37_POLICY: "ask", P37_APPROVE: "resolve", P37_TOOL: "precommit-exit", P37_EXIT: "none" });
    check("F child exited 137 (crash before commit)", code === 137, `code=${code}`);
    const store = new FileRecoveryStore(dir);
    const ext = new ExternalResource(path.join(dir, "external.json"));
    check("F external NOT committed yet (count 0)", (await ext.commitCount()) === 0);
    const rec0 = await store.load(sess);
    check("F durable status approved (human approved, tool pending)", rec0?.status === "approved", String(rec0?.status));
    const model = new ScriptedModel();
    model.enqueueTool({ name: "commit_record", arguments: { idempotencyKey: key } });
    model.enqueueFinal("done");
    const rt = buildRuntime({ sessionId: sess, store, model, dir, policy: askNever });
    const rr = await rt.recoverIfUnfinished(reconcileFileExternal(ext));
    check("F recovery continue (no external reconcile for human-gated)", rr.decision === "continue", rr.decision);
    const res = await rt.run("resume");
    await rt.waitForIdle();
    check("F tool executed at most once (count 1)", (await ext.commitCount()) === 1, `count=${await ext.commitCount()}`);
    void res;
  }

  // ============ G — 外部 commit + crash → SKIP（回归：现有 External Recovery 未被破坏） ============
  {
    const dir = await mkdtemp(path.join(os.tmpdir(), "p37b-G-"));
    const key = "op-G";
    const sess = "sess-G";
    const code = await runChild({ P37_DIR: dir, P37_SESSION: sess, P37_KEY: key, P37_POLICY: "allow", P37_TOOL: "commit-exit", P37_EXIT: "none" });
    check("G child exited 137 (death after commit)", code === 137, `code=${code}`);
    const store = new FileRecoveryStore(dir);
    const ext = new ExternalResource(path.join(dir, "external.json"));
    check("G external COMMITTED before crash (count 1)", (await ext.commitCount()) === 1);
    const model = new ScriptedModel();
    model.enqueueFinal("already committed");
    const rt = buildRuntime({ sessionId: sess, store, model, dir, policy: askNever });
    const rr = await rt.recoverIfUnfinished(reconcileFileExternal(ext));
    check("G decision == SKIP (SUCCESS)", rr.decision === "skip", rr.decision);
    const res = await rt.run("continue");
    await rt.waitForIdle();
    check("G external count still 1 (no duplicate)", (await ext.commitCount()) === 1, `count=${await ext.commitCount()}`);
    void res;
  }

  // ============ 重复 Approve：Approve(A); Approve(A) → Tool 只执行一次 ============
  {
    const dir = await mkdtemp(path.join(os.tmpdir(), "p37b-DUP-"));
    const key = "op-DUP";
    const sess = "sess-DUP";
    const store = new FileRecoveryStore(dir);
    const ext = new ExternalResource(path.join(dir, "external.json"));
    const model = new ScriptedModel();
    model.enqueueTool({ name: "commit_record", arguments: { idempotencyKey: key } });
    model.enqueueFinal("done");
    const rt = buildRuntime({ sessionId: sess, store, model, dir, policy: askNever });
    const runP = rt.run("dup");
    await waitFor(async () => (await store.load(sess))?.status === "pending_approval");
    const aid = (await store.load(sess))!.approvalId!;
    await rt.applyDecision(aid, "allow");
    await rt.applyDecision(aid, "allow"); // 重复
    await runP;
    await rt.waitForIdle();
    check("DUP tool executed exactly once", (await ext.commitCount()) === 1, `count=${await ext.commitCount()}`);
    const rec = await store.load(sess);
    check("DUP final status recovered", rec?.status === "recovered", String(rec?.status));
  }

  // ============ Approve/Reject 竞态：只能产生一次 terminal transition ============
  async function raceCase(name: string, first: PolicyOutcome, second: PolicyOutcome): Promise<void> {
    const dir = await mkdtemp(path.join(os.tmpdir(), `p37b-${name}-`));
    const key = "op-" + name;
    const sess = "sess-" + name;
    const store = new FileRecoveryStore(dir);
    const ext = new ExternalResource(path.join(dir, "external.json"));
    const model = new ScriptedModel();
    model.enqueueTool({ name: "commit_record", arguments: { idempotencyKey: key } });
    model.enqueueFinal("done");
    const rt = buildRuntime({ sessionId: sess, store, model, dir, policy: askNever });
    const runP = rt.run("race");
    await waitFor(async () => (await store.load(sess))?.status === "pending_approval");
    const aid = (await store.load(sess))!.approvalId!;
    const p1 = rt.applyDecision(aid, first);
    const p2 = rt.applyDecision(aid, second);
    await Promise.all([p1, p2]);
    await runP;
    await rt.waitForIdle();
    const rec = await store.load(sess);
    // terminal = 人类决议（approved/rejected）或 approved 已执行（recovered）；绝不会同时 approved 与 rejected。
    const terminal = rec?.status === "approved" || rec?.status === "rejected" || rec?.status === "recovered";
    check(`${name} exactly one terminal transition`, terminal, String(rec?.status));
    const expected = rec?.status === "rejected" ? 0 : 1;
    check(`${name} side effect consistent with decision (count ${expected})`, (await ext.commitCount()) === expected, `count=${await ext.commitCount()}`);
  }
  await raceCase("RACE-AR", "allow", "deny");
  await raceCase("RACE-RA", "deny", "allow");

  // ============ 跨 Run 隔离：Approve(A) 不得改变 B；approvalId 是 operation-level 身份 ============
  {
    const dir = await mkdtemp(path.join(os.tmpdir(), "p37b-ISO-"));
    const store = new FileRecoveryStore(dir);
    const ext = new ExternalResource(path.join(dir, "external.json"));
    const policyA: Policy = (ctx) =>
      ctx.toolName === "commit_record" ? { type: "ask", approval: () => new Promise<PolicyOutcome>(() => {}) } : { type: "allow" };

    const modelA = new ScriptedModel();
    modelA.enqueueTool({ name: "commit_record", arguments: { idempotencyKey: "Alice" } });
    modelA.enqueueFinal("done");
    const rtA = buildRuntime({ sessionId: "sess-ISO-A", store, model: modelA, dir, policy: policyA });
    const runA = rtA.run("A");
    await waitFor(async () => (await store.load("sess-ISO-A"))?.status === "pending_approval");
    const aidA = (await store.load("sess-ISO-A"))!.approvalId!;

    const modelB = new ScriptedModel();
    modelB.enqueueTool({ name: "commit_record", arguments: { idempotencyKey: "Bob" } });
    modelB.enqueueFinal("done");
    const rtB = buildRuntime({ sessionId: "sess-ISO-B", store, model: modelB, dir, policy: policyA });
    const runB = rtB.run("B");
    await waitFor(async () => (await store.load("sess-ISO-B"))?.status === "pending_approval");
    const aidB = (await store.load("sess-ISO-B"))!.approvalId!;

    check("ISO distinct approvalIds (operation-level identity)", aidA !== aidB, `${aidA} vs ${aidB}`);

    // 只批准 A
    await rtA.applyDecision(aidA, "allow");
    await runA;
    await rtA.waitForIdle();
    void runB; // B 故意保持 pending（无批准），不 await（否则挂起）

    await new Promise((r) => setTimeout(r, 150)); // 让 A 执行 + B 的 pending 落盘
    const recB = await store.load("sess-ISO-B");
    check("ISO approving A does NOT change B (B still pending)", recB?.status === "pending_approval", String(recB?.status));
    check("ISO A executed once, B not", (await ext.commitCount()) === 1, `count=${await ext.commitCount()}`);
  }

  // ============ 硬化回归 R1 — 操作域审批：approved 续跑必须 toolName + args 指纹一致 ============
  // 子进程先把 pending 决议为 approved 但 Tool 在 commit 前崩溃（store=approved，未执行副作用）。
  // 父进程以「不同 args」续跑 → 必须被拒绝（不可借旧 approval 静默放行其它操作）。
  {
    const dir = await mkdtemp(path.join(os.tmpdir(), "p37b-R1-"));
    const key1 = "op-R1-A";
    const sess = "sess-R1";
    const code = await runChild({ P37_DIR: dir, P37_SESSION: sess, P37_KEY: key1, P37_POLICY: "ask", P37_APPROVE: "resolve", P37_TOOL: "precommit-exit", P37_EXIT: "none" });
    check("R1 child died before commit (store approved, no side effect)", code === 137, `code=${code}`);
    const store = new FileRecoveryStore(dir);
    const ext = new ExternalResource(path.join(dir, "external.json"));
    const rec0 = await store.load(sess);
    check("R1 durable status approved (human approved, tool not executed)", rec0?.status === "approved", String(rec0?.status));
    check("R1 argsFingerprint persisted", !!rec0?.checkpoint.argsFingerprint, String(rec0?.checkpoint.argsFingerprint));
    // 续跑：不同 idempotencyKey（args 指纹不匹配）→ 必须被拒绝
    const model = new ScriptedModel();
    model.enqueueTool({ name: "commit_record", arguments: { idempotencyKey: "op-R1-B" } });
    model.enqueueFinal("done");
    const rt = buildRuntime({ sessionId: sess, store, model, dir, policy: askNever });
    const res = await rt.run("resume-mismatch");
    await rt.waitForIdle();
    check("R1 mismatched args BLOCKED (no second execute)", (await ext.commitCount()) === 0, `count=${await ext.commitCount()}`);
    check("R1 run completed without executing foreign op", res.status === "completed", res.status);
    const rec1 = await store.load(sess);
    check("R1 store still approved (mismatch did not consume approval)", rec1?.status === "approved", String(rec1?.status));
  }

  // ============ 硬化回归 R1b — 操作域审批：相同 toolName + args 指纹 → 放行执行 ============
  {
    const dir = await mkdtemp(path.join(os.tmpdir(), "p37b-R1b-"));
    const key1 = "op-R1b";
    const sess = "sess-R1b";
    await runChild({ P37_DIR: dir, P37_SESSION: sess, P37_KEY: key1, P37_POLICY: "ask", P37_APPROVE: "resolve", P37_TOOL: "precommit-exit", P37_EXIT: "none" });
    const store = new FileRecoveryStore(dir);
    const ext = new ExternalResource(path.join(dir, "external.json"));
    // 续跑：相同 idempotencyKey（args 指纹匹配）→ 放行
    const model = new ScriptedModel();
    model.enqueueTool({ name: "commit_record", arguments: { idempotencyKey: key1 } });
    model.enqueueFinal("done");
    const rt = buildRuntime({ sessionId: sess, store, model, dir, policy: askNever });
    const res = await rt.run("resume-match");
    await rt.waitForIdle();
    check("R1b matched args executed exactly once", (await ext.commitCount()) === 1, `count=${await ext.commitCount()}`);
    check("R1b run completed", res.status === "completed", res.status);
    const rec = await store.load(sess);
    check("R1b durable status recovered (approved→executed)", rec?.status === "recovered", String(rec?.status));
  }

  // ============ 硬化回归 R2 — 双决策源竞态：promise allow + store deny ⇒ deny 胜 ============
  // store 是唯一真相源；Runtime 绝不只凭已 resolve 的 promise 执行 Tool。
  // 外部 applyDecision(deny) 先提交 store=rejected（承诺值随之 resolve 为 committed "deny"），
  // 此后即使「人类点击批准」(allow) 也只能是幂等 no-op，Tool 永不执行。
  {
    const dir = await mkdtemp(path.join(os.tmpdir(), "p37b-R2-"));
    const key = "op-R2";
    const sess = "sess-R2";
    const store = new FileRecoveryStore(dir);
    const ext = new ExternalResource(path.join(dir, "external.json"));
    const auditFile = path.join(dir, "audit.jsonl");
    const audit = new FileAuditSink(auditFile);

    // 可控人工入口：test 持有 humanResolve，可随时「模拟人类点击批准」。
    let humanResolve: (o: PolicyOutcome) => void = () => {};
    const humanPromise = new Promise<PolicyOutcome>((r) => { humanResolve = r; });
    const policy: Policy = (ctx) =>
      ctx.toolName === "commit_record" ? { type: "ask", approval: () => humanPromise } : { type: "allow" };

    const model = new ScriptedModel();
    model.enqueueTool({ name: "commit_record", arguments: { idempotencyKey: key } });
    model.enqueueFinal("done");
    const rt = buildRuntime({ sessionId: sess, store, audit, model, dir, policy });
    const runP = rt.run("race");
    await waitFor(async () => (await store.load(sess))?.status === "pending_approval");
    const aid = (await store.load(sess))!.approvalId!;

    // 外部决议：deny 先提交（store=rejected，承诺值 resolve 为 committed "deny"）
    await rt.applyDecision(aid, "deny");
    await runP;
    await rt.waitForIdle();
    // 此刻 Runtime 已据 store=rejected 拒绝 Tool 执行；再「模拟人类点击批准」只是幂等 no-op。
    humanResolve("allow");
    await new Promise((r) => setTimeout(r, 100));

    const rec = await store.load(sess);
    check("R2 store is single source of truth (rejected)", rec?.status === "rejected", String(rec?.status));
    check("R2 tool NEVER executed (deny wins over human allow)", (await ext.commitCount()) === 0, `count=${await ext.commitCount()}`);
    const evts = await readAudit(auditFile);
    check("R2 audit APPROVAL_DECISION REJECTED (not APPROVED)", evts.some((e) => e.eventType === "APPROVAL_DECISION" && e.approvalDecision === "REJECTED"));
    check("R2 NO TOOL_EXECUTION started for human-gated op", !evts.some((e) => e.eventType === "TOOL_EXECUTION" && e.toolName === "commit_record"));
  }

  console.log(`\n=== Phase 37-B acceptance: ${failures === 0 ? "PASS" : "FAIL"} (failures=${failures}) ===`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error("ACCEPTANCE ERROR:", e);
  process.exitCode = 1;
});
