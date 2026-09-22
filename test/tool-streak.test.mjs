/**
 * tool-streak.test.mjs — 同工具连续调用计数 + 苗头提醒 + 兜底第四轨道（#1020 T013）
 *
 * 覆盖：
 *   1. 苗头提醒：toolStreak 达 nudgeThreshold(2) → allow + additionalContext/systemMessage（FR-001）
 *   2. 周期噪声控制：同苗头周期只提醒一次（FR-002）
 *   3. 兜底第四轨道：toolStreak 达 toolStreakLimit(12) → ask 人工审批（FR-006）
 *   4. signals 留痕触发：兜底时 writeSignal 被调用（FR-011）
 *   5. 豁免工具跳过（FR-014）
 *   6. 指纹优先顺序判定（FR-013）：同参数 streak 达阈值时 deny 优先于苗头
 *   7. #993 循环②模拟：同工具 800 次参数变异调用在第 12 次被 ask 截断（AC-013）
 *   8. #993 循环③回归：同参数第 3 次 deny（既有指纹机制，AC-001 回归）
 *   9. 换工具重置 toolStreak（合法批量操作跨工具不受影响）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/runtime.mjs';
import { clearState } from '../src/lib/state.mjs';

const TEST_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-hook-ts-'));
process.env.ASTRA_HOOK_STATE_DIR = TEST_STATE;

const SESSION = 'tool-streak-session';

test.beforeEach(() => {
  clearState('loop-guard', SESSION);
});

/** 构造参数各不相同的同工具调用（参数变异——指纹去重的盲区） */
const mkVaried = (n) => JSON.stringify({
  sessionId: SESSION,
  toolName: 'edit_file',
  toolInput: { filePath: `/tmp/f${n}.txt`, newStr: `content-${n}`, editType: 'replace' },
  hookEventName: 'PreToolUse',
});

/** 构造参数完全相同的同工具调用（指纹去重的射程） */
const mkSame = () => JSON.stringify({
  sessionId: SESSION,
  toolName: 'mcp_github_mcp_se_add_issue_comment',
  toolInput: { body: 'x', issue_number: 1, owner: 'o', repo: 'r' },
  hookEventName: 'PreToolUse',
});

test('TS1: 苗头提醒——同工具第 2 次调用（参数不同）→ allow + additionalContext/systemMessage', async () => {
  await run('loop-guard', mkVaried(1), {});
  const r2 = await run('loop-guard', mkVaried(2), {});
  assert.equal(r2.hookSpecificOutput.permissionDecision, 'allow', '苗头是软引导不阻断');
  assert.ok(r2.hookSpecificOutput.additionalContext, '苗头必须携带 additionalContext（主通道）');
  assert.match(r2.hookSpecificOutput.additionalContext, /循环苗头提醒/);
  assert.ok(r2.systemMessage, '苗头必须携带 systemMessage（兜底通道）');
  assert.match(r2.systemMessage, /循环嫌疑/);
});

test('TS2: 周期噪声控制——同苗头周期只提醒一次（FR-002）', async () => {
  await run('loop-guard', mkVaried(1), {});
  const r2 = await run('loop-guard', mkVaried(2), {});
  assert.ok(r2.hookSpecificOutput.additionalContext, '第 2 次提醒');
  const r3 = await run('loop-guard', mkVaried(3), {});
  assert.equal(r3.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(r3.hookSpecificOutput.additionalContext, undefined, '同周期第 3 次不再提醒');
  assert.equal(r3.systemMessage, undefined);
});

test('TS3: 兜底第四轨道——toolStreak 达 12 → ask 人工审批（FR-006）', async () => {
  // 12 次参数变异调用（每次不同，指纹不触发）
  let last;
  for (let i = 1; i <= 12; i++) {
    last = await run('loop-guard', mkVaried(i), {});
  }
  assert.equal(last.hookSpecificOutput.permissionDecision, 'ask', '第 12 次触发兜底 ask');
  assert.match(last.hookSpecificOutput.permissionDecisionReason, /兜底熔断/);
  assert.match(last.systemMessage, /换着花样|参数各不相同|严禁通过变更参数继续/);
});

test('TS4: 兜底触发写 signals.jsonl（FR-011）', async () => {
  const sigFile = path.join(TEST_STATE, 'signals-test.jsonl');
  process.env.ASTRA_SIGNALS_FILE = sigFile;
  try {
    for (let i = 1; i <= 12; i++) await run('loop-guard', mkVaried(`sig-${i}`), {});
    assert.ok(fs.existsSync(sigFile), 'signals.jsonl 已写入');
    const line = fs.readFileSync(sigFile, 'utf8').trim().split('\n').pop();
    const rec = JSON.parse(line);
    assert.equal(rec.signal_type, 'gap');
    assert.equal(rec.layer, 'L2');
    assert.equal(rec.direction, 'backward');
    assert.equal(rec.status, 'pending');
    assert.match(rec.description, /兜底熔断/);
  } finally {
    delete process.env.ASTRA_SIGNALS_FILE;
  }
});

test('TS5: 豁免工具跳过苗头与计数（FR-014）', async () => {
  const mkRead = (n) => JSON.stringify({
    sessionId: SESSION,
    toolName: 'read_file', // 豁免名单内
    toolInput: { filePath: `/tmp/r${n}.txt` },
    hookEventName: 'PreToolUse',
  });
  for (let i = 1; i <= 15; i++) {
    const r = await run('loop-guard', mkRead(i), {});
    assert.equal(r.hookSpecificOutput.permissionDecision, 'allow', `豁免工具第 ${i} 次仍放行`);
    assert.equal(r.hookSpecificOutput.additionalContext, undefined, '豁免工具无苗头提醒');
  }
});

test('TS6: 指纹优先（FR-013）——同参数 streak 达阈值时 deny 优先于苗头 allow', async () => {
  // 同参数调用：第 2 次时 toolStreak=2（达苗头阈值）但 streak=2 < threshold=3 → 苗头
  await run('loop-guard', mkSame(), {});
  const r2 = await run('loop-guard', mkSame(), {});
  assert.equal(r2.hookSpecificOutput.permissionDecision, 'allow');
  assert.ok(r2.hookSpecificOutput.additionalContext, 'streak=2 < threshold=3 → 苗头生效');
  // 第 3 次：streak=3 达指纹阈值 → deny 优先（苗头不截断 deny）
  const r3 = await run('loop-guard', mkSame(), {});
  assert.equal(r3.hookSpecificOutput.permissionDecision, 'deny', '指纹命中优先于苗头');
});

test('TS7: #993 循环②模拟——同工具 800 次参数变异调用在第 12 次被 ask 截断（AC-013）', async () => {
  // 反事实：#993 实际 800+ 次 memory 编辑未被拦截；修复后第 12 次即 ask
  let firstAsk = -1;
  for (let i = 1; i <= 20; i++) {
    const r = await run('loop-guard', mkVaried(`loop2-${i}`), {});
    if (r.hookSpecificOutput.permissionDecision === 'ask' && firstAsk === -1) {
      firstAsk = i;
    }
    // ask 之后继续调用仍为 ask（持续拦截）
    if (firstAsk > 0 && i > firstAsk) {
      assert.equal(r.hookSpecificOutput.permissionDecision, 'ask', `第 ${i} 次仍保持拦截`);
    }
  }
  assert.equal(firstAsk, 12, '首次 ask 恰在第 12 次（toolStreakLimit）');
});

test('TS8: #993 循环③回归——同参数第 3 次 deny（AC-001 既有机制）', async () => {
  await run('loop-guard', mkSame(), {});
  await run('loop-guard', mkSame(), {});
  const r3 = await run('loop-guard', mkSame(), {});
  assert.equal(r3.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r3.hookSpecificOutput.permissionDecisionReason, /防循环拦截/);
});

test('TS9: 换工具重置 toolStreak（合法批量操作跨工具不受影响）', async () => {
  // 工具 A 连续 5 次（接近兜底但未触发）
  for (let i = 1; i <= 5; i++) await run('loop-guard', mkVaried(`a-${i}`), {});
  // 切换工具 B：toolStreak 重置为 1
  const mkB = (n) => JSON.stringify({
    sessionId: SESSION,
    toolName: 'create_file',
    toolInput: { filePath: `/tmp/b${n}.txt`, content: `c-${n}` },
    hookEventName: 'PreToolUse',
  });
  const rB1 = await run('loop-guard', mkB(1), {});
  assert.equal(rB1.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(rB1.hookSpecificOutput.additionalContext, undefined, '换工具后苗头周期重置');
  // 工具 B 再连续 10 次（总 streak 11 < 12）不触发兜底
  for (let i = 2; i <= 11; i++) {
    const r = await run('loop-guard', mkB(i), {});
    assert.notEqual(r.hookSpecificOutput.permissionDecision, 'ask', `工具 B 第 ${i} 次不应触发兜底（toolStreak=${i}）`);
  }
});
