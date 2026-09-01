/**
 * circuit-breaker.test.mjs — 熔断器回归（2026-09-01，#899 事故 168 次拦截仍重试）
 *
 * 覆盖：
 *   1. streak 达 breakerLimit → continue:false + stopReason（终止整个回合）
 *   2. breakerLimit 之前仍是 per-call deny（含升级警告）
 *   3. 熔断消息含恢复方式（新回合 + 换方案契约）
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

test('CB: below breakerLimit → per-call deny with escalation warning', async () => {
  const mk = () => JSON.stringify({
    sessionId: SESSION,
    toolName: 'mcp_github_mcp_se_add_issue_comment',
    toolInput: { body: 'x', issue_number: 1, owner: 'o', repo: 'r' },
    hookEventName: 'PreToolUse',
  });
  // threshold=3, breakerLimit=8：第 3~7 次 deny
  for (let i = 0; i < 6; i++) await run('loop-guard', mk(), {});
  const r7 = await run('loop-guard', mk(), {});
  assert.equal(r7.hookSpecificOutput.permissionDecision, 'deny');
  assert.notEqual(r7.continue, false, 'below breakerLimit must NOT terminate turn');
  assert.match(r7.hookSpecificOutput.permissionDecisionReason, /强制终止本回合/);
});

test('CB: at breakerLimit → circuit breaker terminates turn', async () => {
  const mk = () => JSON.stringify({
    sessionId: SESSION,
    toolName: 'mcp_github_mcp_se_add_issue_comment',
    toolInput: { body: 'y', issue_number: 2, owner: 'o', repo: 'r' },
    hookEventName: 'PreToolUse',
  });
  // 第 8 次调用（streak=8 >= breakerLimit=8）→ 熔断
  for (let i = 0; i < 7; i++) await run('loop-guard', mk(), {});
  const r8 = await run('loop-guard', mk(), {});
  assert.equal(r8.continue, false, 'at breakerLimit must terminate turn');
  assert.ok(r8.stopReason, 'must include stopReason');
  assert.match(r8.stopReason, /强制终止/);
  assert.match(r8.stopReason, /严禁原样重试/);
  assert.match(r8.hookSpecificOutput.permissionDecisionReason, /熔断/);
  assert.match(r8.hookSpecificOutput.permissionDecisionReason, /恢复方式/);
});

test('CB: beyond breakerLimit stays terminated (idempotent)', async () => {
  const mk = () => JSON.stringify({
    sessionId: SESSION,
    toolName: 'mcp_github_mcp_se_add_issue_comment',
    toolInput: { body: 'z', issue_number: 3, owner: 'o', repo: 'r' },
    hookEventName: 'PreToolUse',
  });
  for (let i = 0; i < 9; i++) await run('loop-guard', mk(), {});
  const r10 = await run('loop-guard', mk(), {});
  assert.equal(r10.continue, false, 'beyond breakerLimit stays terminated');
});
