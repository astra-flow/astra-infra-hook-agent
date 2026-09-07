/**
 * coverage-defensive.test.mjs — 防御分支覆盖收尾（#957 100% 目标）
 *
 * 覆盖：
 *   - runtime.mjs 103（hook 返回无决策对象 → no decision fail-open）
 *   - bin/astra-hook.mjs 64-68（main().catch 顶层兜底：决策输出抛错 → fail-open allow）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'astra-hook.mjs');

const TEST_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-hook-def-'));
process.env.ASTRA_HOOK_STATE_DIR = TEST_STATE;

test('DEF: runtime — hook returns non-decision object → no decision fail-open (103)', async () => {
  // 动态注册临时 hook：metadata key + 返回无 hookSpecificOutput 对象的模块
  const { HOOK_METADATA } = await import('../src/lib/config.mjs');
  const tmpHook = path.join(ROOT, 'src', 'hooks', '__cov_no_decision__.mjs');
  HOOK_METADATA['__cov_no_decision__'] = {
    name: '__cov_no_decision__',
    events: ['PreToolUse'],
    timeoutMs: 1000,
    platforms: ['vscode'],
  };
  fs.writeFileSync(tmpHook, 'export default async function () { return { foo: 1 }; }\n', 'utf8');
  try {
    const { run } = await import('../src/runtime.mjs');
    const r = await run('__cov_no_decision__', JSON.stringify({ sessionId: 'x', hookEventName: 'PreToolUse' }), {});
    assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
    assert.equal(r.hookSpecificOutput.permissionDecisionReason, '__cov_no_decision__: no decision, fail-open');
  } finally {
    fs.rmSync(tmpHook, { force: true });
    delete HOOK_METADATA['__cov_no_decision__'];
  }
});

test('DEF: bin — decision output write throws → main().catch fail-open allow (64-68)', () => {
  // 子进程内 mock process.stdout.write：首次调用（决策输出）抛同步异常
  // → main() async 链内 throw → main().catch → 兜底输出 allow + exit 0
  const script = `
    const origWrite = process.stdout.write.bind(process.stdout);
    let callCount = 0;
    process.stdout.write = function (chunk) {
      callCount++;
      if (callCount === 1) throw new Error('mock write boom');
      return origWrite(chunk);
    };
    process.argv[2] = 'loop-guard';
    await import(${JSON.stringify(BIN)});
    process.stdin.emit('data', JSON.stringify({ sessionId: 'x', hookEventName: 'PreToolUse' }));
    process.stdin.emit('end');
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 15000, cwd: ROOT,
    env: { ...process.env, ASTRA_HOOK_STATE_DIR: TEST_STATE },
  });
  assert.equal(res.status, 0, 'main().catch must exit 0');
  const out = JSON.parse(res.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow', 'top-level fallback outputs allow');
  assert.equal(out.hookSpecificOutput.hookEventName, '');
});
