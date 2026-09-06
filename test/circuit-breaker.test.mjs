/**
 * circuit-breaker.test.mjs — 熔断器回归（2026-09-07 更新，#957）
 *
 * 历史：2026-09-01（#899）引入 continue:false 熔断；#948 二次事故实证
 * VS Code 实际环境熔断未能终止回合（290 次拦截仍重试），#957 将熔断
 * 终态改为 ask 兜底（强制人工审批）。
 *
 * 覆盖：
 *   1. streak < askThreshold → per-call deny（正向指令）
 *   2. askThreshold ≤ streak < breakerLimit → ask（人工审批升级）
 *   3. streak ≥ breakerLimit → ask 兜底（熔断语义，非 continue:false）
 *   4. 熔断消息含人工审批与恢复契约
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/runtime.mjs';
import { clearState } from '../src/lib/state.mjs';

const TEST_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-hook-cb-'));
process.env.ASTRA_HOOK_STATE_DIR = TEST_STATE;

const SESSION = 'cb-test-session';

test.beforeEach(() => {
  clearState('loop-guard', SESSION);
});

test('CB: below askThreshold → per-call deny with positive instruction', async () => {
  const mk = () => JSON.stringify({
    sessionId: SESSION,
    toolName: 'mcp_github_mcp_se_add_issue_comment',
    toolInput: { body: 'x', issue_number: 1, owner: 'o', repo: 'r' },
    hookEventName: 'PreToolUse',
  });
  // threshold=3, askThreshold=5：第 3~4 次 deny
  for (let i = 0; i < 3; i++) await run('loop-guard', mk(), {});
  const r4 = await run('loop-guard', mk(), {});
  assert.equal(r4.hookSpecificOutput.permissionDecision, 'deny');
  assert.notEqual(r4.continue, false, 'below askThreshold must NOT terminate turn');
  assert.match(r4.hookSpecificOutput.permissionDecisionReason, /下一步行动/);
});

test('CB: at askThreshold → ask (human approval escalation)', async () => {
  const mk = () => JSON.stringify({
    sessionId: SESSION,
    toolName: 'mcp_github_mcp_se_add_issue_comment',
    toolInput: { body: 'y', issue_number: 2, owner: 'o', repo: 'r' },
    hookEventName: 'PreToolUse',
  });
  // 第 5 次调用（streak=5 >= askThreshold=5）→ ask
  for (let i = 0; i < 4; i++) await run('loop-guard', mk(), {});
  const r5 = await run('loop-guard', mk(), {});
  assert.equal(r5.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(r5.hookSpecificOutput.permissionDecisionReason, /人工审批/);
  assert.notEqual(r5.continue, false, 'ask must not terminate turn');
});

test('CB: at breakerLimit → ask fallback (circuit breaker semantics)', async () => {
  const mk = () => JSON.stringify({
    sessionId: SESSION,
    toolName: 'mcp_github_mcp_se_add_issue_comment',
    toolInput: { body: 'z', issue_number: 3, owner: 'o', repo: 'r' },
    hookEventName: 'PreToolUse',
  });
  // 第 8 次调用（streak=8 >= breakerLimit=8）→ ask 兜底
  for (let i = 0; i < 7; i++) await run('loop-guard', mk(), {});
  const r8 = await run('loop-guard', mk(), {});
  assert.equal(r8.hookSpecificOutput.permissionDecision, 'ask', 'at breakerLimit must escalate to ask');
  assert.equal(r8.continue, undefined, 'must NOT use continue:false (proven ineffective in VS Code, #948)');
  assert.match(r8.hookSpecificOutput.permissionDecisionReason, /熔断/);
  assert.match(r8.hookSpecificOutput.permissionDecisionReason, /人工审批/);
  assert.match(r8.systemMessage, /人工审批/);
  assert.match(r8.systemMessage, /严禁原样重试/);
});

test('CB: beyond breakerLimit stays ask (idempotent)', async () => {
  const mk = () => JSON.stringify({
    sessionId: SESSION,
    toolName: 'mcp_github_mcp_se_add_issue_comment',
    toolInput: { body: 'w', issue_number: 4, owner: 'o', repo: 'r' },
    hookEventName: 'PreToolUse',
  });
  for (let i = 0; i < 9; i++) await run('loop-guard', mk(), {});
  const r10 = await run('loop-guard', mk(), {});
  assert.equal(r10.hookSpecificOutput.permissionDecision, 'ask', 'beyond breakerLimit stays ask');
});
