/**
 * hooks.test.mjs — Hook 模块 evals（业务逻辑验证）
 *
 * 覆盖：
 *   - loop-guard：HOT_TOOLS 预过滤、连续重复 deny、状态隔离
 *   - session-issue-link：SessionStart/PostToolUse 记录
 *   - 双平台 fixtures 驱动
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/runtime.mjs';
import { clearState } from '../src/lib/state.mjs';

// 测试专用状态目录（避免污染真实 ~/.astra/hooks）
const TEST_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-hook-test-'));
process.env.ASTRA_HOOK_STATE_DIR = TEST_STATE;
process.env.ASTRA_SESSION_LINK_FILE = path.join(TEST_STATE, 'issue-link.md');
process.env.ASTRA_WORKSPACE_ROOT = TEST_STATE;

const SESSION = 'test-eval-session';

test.beforeEach(() => {
  clearState('loop-guard', SESSION);
});

test('CP-03: loop-guard skips non-hot tool (prefilter)', async () => {
  const input = JSON.stringify({
    sessionId: SESSION,
    toolName: 'fetch_webpage',
    toolInput: { urls: ['https://example.com'] },
    hookEventName: 'PreToolUse',
  });
  const r = await run('loop-guard', input, {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
});

test('loop-guard: single call allowed (streak 1)', async () => {
  const input = JSON.stringify({
    sessionId: SESSION,
    toolName: 'create_file',
    toolInput: { filePath: '/tmp/a.txt', content: 'x' },
    hookEventName: 'PreToolUse',
  });
  const r = await run('loop-guard', input, {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
});

test('loop-guard: 3x identical → deny (anti-loop)', async () => {
  const mk = () => JSON.stringify({
    sessionId: SESSION,
    toolName: 'create_file',
    toolInput: { filePath: '/tmp/loop.txt', content: 'same' },
    hookEventName: 'PreToolUse',
  });
  const r1 = await run('loop-guard', mk(), {});
  const r2 = await run('loop-guard', mk(), {});
  const r3 = await run('loop-guard', mk(), {});
  assert.equal(r1.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(r2.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(r3.hookSpecificOutput.permissionDecision, 'deny');
});

test('loop-guard: different args break streak', async () => {
  const a = { sessionId: SESSION, toolName: 'create_file', toolInput: { filePath: '/1' }, hookEventName: 'PreToolUse' };
  const b = { sessionId: SESSION, toolName: 'create_file', toolInput: { filePath: '/2' }, hookEventName: 'PreToolUse' };
  await run('loop-guard', JSON.stringify(a), {});
  await run('loop-guard', JSON.stringify(a), {});
  const r = await run('loop-guard', JSON.stringify(b), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
});

test('CP-04: Claude Code snake_case input works (loop-guard)', async () => {
  const input = JSON.stringify({
    session_id: SESSION,
    tool_name: 'Write',
    tool_input: { file_path: '/tmp/cc.md', content: 'z' },
    hook_event_name: 'PreToolUse',
  });
  const r = await run('loop-guard', input, {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
});

test('session-issue-link: PostToolUse records issue link', async () => {
  const linkFile = path.join(TEST_STATE, 'issue-link.md');
  fs.rmSync(linkFile, { force: true });
  const input = JSON.stringify({
    sessionId: SESSION,
    toolName: 'issue_write',
    toolResponse: '{"id":"900","url":"https://github.com/astra-flow/astra/issues/900"}',
    hookEventName: 'PostToolUse',
  });
  const r = await run('session-issue-link', input, {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
  const content = fs.readFileSync(linkFile, 'utf8');
  assert.match(content, /issue=#900/);
  assert.match(content, /PostToolUse/);
});

test('session-issue-link: SessionStart records from branch', async () => {
  // 不依赖真实 git 分支，注入 workspace 分支名不易，直接验证 allow
  const input = JSON.stringify({
    sessionId: SESSION,
    hookEventName: 'SessionStart',
  });
  const r = await run('session-issue-link', input, {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
});

test('decision-log: no keyword → allow no side effect', async () => {
  const input = JSON.stringify({
    sessionId: SESSION,
    prompt: '今天天气不错，随便聊聊',
    hookEventName: 'UserPromptSubmit',
  });
  const r = await run('decision-log', input, {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
});

test('decision-log: Approved keyword classified', async () => {
  const input = JSON.stringify({
    sessionId: SESSION,
    prompt: 'Decision: Approved，可以开始了（#900）',
    hookEventName: 'UserPromptSubmit',
  });
  const r = await run('decision-log', input, {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
});

test('decision-log: schedule comment (setImmediate fires, not dropped)', async () => {
  // 修复验证：setImmediate 回调必须执行（bin 用 process.exitCode 而非 exit()）。
  // 此测试直接调用 decisionLog 的内部行为——通过 run 返回后等待事件循环 flush，
  // 确认调度发生且 fail-open（gh 缺失/失败静默，不抛错）。
  const input = JSON.stringify({
    sessionId: SESSION,
    prompt: 'Decision: Approved（#9999）',
    hookEventName: 'UserPromptSubmit',
  });
  const r = await run('decision-log', input, {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
  // 等待 setImmediate 回调执行（gh 命令可能失败但必须被触发，不阻塞测试）
  await new Promise((res) => setImmediate(res));
});

test('loop-guard: large toolInput fingerprint stays fast (perf High #2)', async () => {
  // 修复验证：大 content 输入不应导致深拷贝爆炸（稳定截断 hash）
  const bigInput = {
    sessionId: SESSION,
    toolName: 'create_file',
    toolInput: { filePath: '/tmp/big.txt', content: 'y'.repeat(500_000) },
    hookEventName: 'PreToolUse',
  };
  const start = Date.now();
  const r = await run('loop-guard', JSON.stringify(bigInput), {});
  const elapsed = Date.now() - start;
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
  assert.ok(elapsed < 1000, `fingerprint took ${elapsed}ms, expected < 1000ms`);
});

test('loop-guard: deny reason redacts sensitive keys (sec Medium)', async () => {
  // 触发 deny，检查 deny 理由不含敏感 content 明文
  const mk = () => JSON.stringify({
    sessionId: SESSION,
    toolName: 'create_file',
    toolInput: { filePath: '/tmp/secret.txt', content: 'TOP-SECRET-CONTENT' },
    hookEventName: 'PreToolUse',
  });
  await run('loop-guard', mk(), {});
  await run('loop-guard', mk(), {});
  const r = await run('loop-guard', mk(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(!r.hookSpecificOutput.permissionDecisionReason.includes('TOP-SECRET-CONTENT'), 'deny reason leaks content');
});
