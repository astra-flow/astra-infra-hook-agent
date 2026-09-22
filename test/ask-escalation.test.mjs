/**
 * ask-escalation.test.mjs — ask 升级与熔断兜底回归（2026-09-07，#957）
 *
 * 背景：#948 二次事故实证 deny 自动拦截与 continue:false 熔断在 VS Code
 * 实际环境均未能终止 Agent 重试（290 次拦截）。#957 将高 streak 场景
 * 升级为 ask（强制人工审批）——平台语义中唯一无法被模型自动绕过的信号。
 *
 * 覆盖：
 *   1. streak < threshold → allow
 *   2. threshold ≤ streak < askThreshold → deny（正向指令，含升级预告）
 *   3. askThreshold ≤ streak < breakerLimit → ask（人工审批）
 *   4. streak ≥ breakerLimit → ask 兜底（熔断语义，非 continue:false）
 *   5. askThreshold 可经 bands.yaml 配置（ASTRA_BANDS_FILE 覆盖）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/runtime.mjs';
import { clearState } from '../src/lib/state.mjs';

const TEST_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-hook-ask-'));
process.env.ASTRA_HOOK_STATE_DIR = TEST_STATE;

const SESSION = 'ask-test-session';

/** 连续调用 n 次相同工具+参数，返回最后一次决策 */
async function callNTimes(n, body = 'x') {
  const mk = () => JSON.stringify({
    sessionId: SESSION,
    toolName: 'mcp_github_mcp_se_add_issue_comment',
    toolInput: { body, issue_number: 1, owner: 'o', repo: 'r' },
    hookEventName: 'PreToolUse',
  });
  let last;
  for (let i = 0; i < n; i++) last = await run('loop-guard', mk(), {});
  return last;
}

test.beforeEach(() => {
  clearState('loop-guard', SESSION);
});

test('ASK: below threshold → allow', async () => {
  const r = await callNTimes(2);
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
});

test('ASK: threshold..askThreshold-1 → deny with positive instruction', async () => {
  // threshold=3, askThreshold=5：第 3~4 次 deny
  const r3 = await callNTimes(3);
  assert.equal(r3.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r3.hookSpecificOutput.permissionDecisionReason, /下一步行动/);
  assert.match(r3.hookSpecificOutput.permissionDecisionReason, /人工审批/);
  assert.notEqual(r3.continue, false, 'deny must not terminate turn');
  const r4 = await callNTimes(1);
  assert.equal(r4.hookSpecificOutput.permissionDecision, 'deny', 'streak=4 still deny');
});

test('ASK: at askThreshold → ask (human approval)', async () => {
  const r5 = await callNTimes(5);
  assert.equal(r5.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(r5.hookSpecificOutput.permissionDecisionReason, /人工审批/);
  assert.notEqual(r5.continue, false, 'ask must not carry continue:false');
});

test('ASK: at breakerLimit → ask fallback (circuit breaker semantics)', async () => {
  const r8 = await callNTimes(8);
  assert.equal(r8.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(r8.hookSpecificOutput.permissionDecisionReason, /熔断/);
  assert.match(r8.hookSpecificOutput.permissionDecisionReason, /人工审批/);
  assert.equal(r8.continue, undefined, 'breaker must NOT use continue:false (proven ineffective in VS Code)');
  assert.match(r8.systemMessage, /人工审批/);
});

test('ASK: beyond breakerLimit stays ask (idempotent)', async () => {
  const r10 = await callNTimes(10);
  assert.equal(r10.hookSpecificOutput.permissionDecision, 'ask');
});

test('ASK: askThreshold configurable via bands file', async () => {
  const bandsFile = path.join(TEST_STATE, 'bands-ask.yaml');
  fs.writeFileSync(bandsFile, [
    'loop-guard:',
    '  threshold: 2',
    '  askThreshold: 3',
    '  breakerLimit: 4',
    '  maxHistory: 50',
    '  nudgeThreshold: 2',
    '  toolStreakLimit: 12',
    '',
  ].join('\n'));
  process.env.ASTRA_BANDS_FILE = bandsFile;
  try {
    clearState('loop-guard', SESSION);
    const r2 = await callNTimes(2, 'cfg');
    assert.equal(r2.hookSpecificOutput.permissionDecision, 'deny', 'streak=2 == threshold → deny');
    const r3 = await callNTimes(1, 'cfg');
    assert.equal(r3.hookSpecificOutput.permissionDecision, 'ask', 'streak=3 == askThreshold → ask');
    const r4 = await callNTimes(1, 'cfg');
    assert.equal(r4.hookSpecificOutput.permissionDecision, 'ask', 'streak=4 == breakerLimit → ask fallback');
  } finally {
    delete process.env.ASTRA_BANDS_FILE;
  }
});
