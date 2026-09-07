/**
 * e2e-contract.test.mjs — 端到端契约测试（#957 AC2 内部验证，2026-09-07）
 *
 * 目的：在内部完成 AC2 验证，不依赖"真实循环场景观察"。
 * 方式：以子进程方式精确模拟 VS Code 调用 hook 的完整链路：
 *   VS Code → spawn(bin/astra-hook.mjs loop-guard) ← stdin JSON → stdout 决策 JSON
 *
 * 验证契约：
 *   1. streak 达 askThreshold（5）→ stdout 输出 permissionDecision:"ask"
 *   2. streak 达 breakerLimit（8）→ ask 兜底（熔断语义），无 continue:false
 *   3. Claude Code snake_case 输入同样可达 ask（平台归一化契约）
 *   4. exit code 0（fail-open 契约：hook 进程永不非零退出）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'astra-hook.mjs');

const TEST_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-hook-e2e-'));
process.env.ASTRA_HOOK_STATE_DIR = TEST_STATE;

const SESSION = 'e2e-ask-session';

/**
 * 子进程调用 hook（完整 VS Code 链路模拟）。
 * 用 spawnSync（同步 + input 写入后关闭 stdin）——execFile 异步版不支持
 * input 选项，stdin 永不关闭会导致 readStdin() 挂起。
 */
function callHook(stdinPayload) {
  const res = spawnSync(process.execPath, [BIN, 'loop-guard'], {
    input: typeof stdinPayload === 'string' ? stdinPayload : JSON.stringify(stdinPayload),
    env: { ...process.env, ASTRA_HOOK_STATE_DIR: TEST_STATE },
    timeout: 15000,
    encoding: 'utf8',
  });
  return res;
}

/** 连续 n 次相同调用，返回最后一次决策 */
function callNTimes(n, payload) {
  let last;
  for (let i = 0; i < n; i++) last = callHook(payload);
  return last;
}

test('E2E: VS Code chain — streak 5 → ask via stdout (AC2 internal verification)', () => {
  const payload = {
    sessionId: SESSION,
    toolName: 'mcp_github_mcp_se_add_issue_comment',
    toolInput: { body: 'e2e', issue_number: 1, owner: 'o', repo: 'r' },
    hookEventName: 'PreToolUse',
  };
  const res = callNTimes(5, payload);
  assert.equal(res.status, 0, 'hook process must exit 0');
  const r5 = JSON.parse(res.stdout);
  assert.equal(r5.hookSpecificOutput.permissionDecision, 'ask', '5th identical call must produce ask via real subprocess chain');
  assert.match(r5.hookSpecificOutput.permissionDecisionReason, /人工审批/);
  assert.equal(r5.continue, undefined);
});

test('E2E: VS Code chain — streak 8 → ask fallback (circuit breaker semantics)', () => {
  const payload = {
    sessionId: `${SESSION}-cb`,
    toolName: 'mcp_github_mcp_se_add_issue_comment',
    toolInput: { body: 'e2e-cb', issue_number: 2, owner: 'o', repo: 'r' },
    hookEventName: 'PreToolUse',
  };
  const res = callNTimes(8, payload);
  const r8 = JSON.parse(res.stdout);
  assert.equal(r8.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(r8.hookSpecificOutput.permissionDecisionReason, /熔断/);
  assert.equal(r8.continue, undefined, 'no continue:false in stdout contract');
});

test('E2E: Claude Code snake_case input reaches ask (normalization contract)', () => {
  const payload = {
    session_id: `${SESSION}-cc`,
    tool_name: 'mcp_github_mcp_se_add_issue_comment',
    tool_input: { body: 'e2e-cc', issue_number: 3, owner: 'o', repo: 'r' },
    hook_event_name: 'PreToolUse',
  };
  const res = callNTimes(5, payload);
  const r5 = JSON.parse(res.stdout);
  assert.equal(r5.hookSpecificOutput.permissionDecision, 'ask', 'snake_case input must normalize and reach ask');
});

test('E2E: hook process always exits 0 (fail-open contract)', () => {
  // 非法 stdin 也不得非零退出
  const res = callHook('not-json');
  assert.equal(res.status, 0, 'process must exit 0 on invalid stdin');
  const out = JSON.parse(res.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow', 'invalid stdin → fail-open allow');
});
