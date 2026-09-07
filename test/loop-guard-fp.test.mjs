/**
 * loop-guard-fp.test.mjs — 误判防护 + 纠偏信息回归（2026-09-01 用户反馈）
 *
 * 覆盖：
 *   1. 轮询类工具（get_terminal_output）连续同参调用 → 豁免不拦截（合法等待模式）
 *   2. deny 输出必须含 systemMessage（Agent 纠偏信息，非仅 UI reason）
 *   3. 连续拦截升级警告（streak 超阈值 2 次以上）
 *   4. 参数变化重置计数（纠偏契约可执行）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/runtime.mjs';
import { clearState } from '../src/lib/state.mjs';

const TEST_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-hook-fp-'));
process.env.ASTRA_HOOK_STATE_DIR = TEST_STATE;

const SESSION = 'fp-test-session';

test.beforeEach(() => {
  clearState('loop-guard', SESSION);
});

test('FP: polling tool (get_terminal_output) repeated calls are exempt', async () => {
  const mk = () => JSON.stringify({
    sessionId: SESSION,
    toolName: 'get_terminal_output',
    toolInput: { id: 'term-123' },
    hookEventName: 'PreToolUse',
  });
  const r1 = await run('loop-guard', mk(), {});
  const r2 = await run('loop-guard', mk(), {});
  const r3 = await run('loop-guard', mk(), {});
  const r4 = await run('loop-guard', mk(), {});
  // 轮询是合法等待模式，连续 4 次也不得拦截
  for (const [i, r] of [r1, r2, r3, r4].entries()) {
    assert.equal(r.hookSpecificOutput.permissionDecision, 'allow', `call ${i + 1} should be exempt`);
  }
});

test('FP: deny output includes systemMessage for agent correction', async () => {
  const mk = () => JSON.stringify({
    sessionId: SESSION,
    toolName: 'mcp_github_mcp_se_add_issue_comment',
    toolInput: { body: 'x', issue_number: 1, owner: 'o', repo: 'r' },
    hookEventName: 'PreToolUse',
  });
  await run('loop-guard', mk(), {});
  await run('loop-guard', mk(), {});
  const r3 = await run('loop-guard', mk(), {});
  assert.equal(r3.hookSpecificOutput.permissionDecision, 'deny');
  // 关键断言：systemMessage 必须存在且含纠偏指引（Agent 可读）
  assert.ok(r3.systemMessage, 'deny must include systemMessage');
  assert.match(r3.systemMessage, /已被阻止/);
  assert.match(r3.systemMessage, /不是瞬时故障/);
  assert.match(r3.systemMessage, /改变行为/);
  // reason 也含可执行的下一步行动（#957 P1a 正向指令）
  assert.match(r3.hookSpecificOutput.permissionDecisionReason, /下一步行动/);
  assert.match(r3.hookSpecificOutput.permissionDecisionReason, /参数变化会重置计数/);
});

test('FP: escalation to ask after repeated denials (#957)', async () => {
  const mk = () => JSON.stringify({
    sessionId: SESSION,
    toolName: 'mcp_github_mcp_se_add_issue_comment',
    toolInput: { body: 'y', issue_number: 2, owner: 'o', repo: 'r' },
    hookEventName: 'PreToolUse',
  });
  // threshold=3, askThreshold=5：第 3/4 次 deny；第 5 次（streak=5）升级为 ask 人工审批
  for (let i = 0; i < 4; i++) await run('loop-guard', mk(), {});
  const r5 = await run('loop-guard', mk(), {});
  assert.equal(r5.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(r5.hookSpecificOutput.permissionDecisionReason, /人工审批/);
});

test('FP: changed args reset streak (correction contract works)', async () => {
  const a = { sessionId: SESSION, toolName: 'mcp_github_mcp_se_add_issue_comment', toolInput: { body: 'same', issue_number: 3, owner: 'o', repo: 'r' }, hookEventName: 'PreToolUse' };
  await run('loop-guard', JSON.stringify(a), {});
  await run('loop-guard', JSON.stringify(a), {});
  // 参数变化 → streak 重置
  const changed = { ...a, toolInput: { body: 'different', issue_number: 3, owner: 'o', repo: 'r' } };
  const r = await run('loop-guard', JSON.stringify(changed), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /streak=1\/3/);
});
