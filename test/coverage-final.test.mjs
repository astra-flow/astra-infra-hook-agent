/**
 * coverage-final.test.mjs — 最终覆盖率补齐（#957 100% 目标）
 *
 * 覆盖：
 *   - decision-log.mjs 76（describePositive 兜底）/ 79-85（describeNegative 全分支）/
 *     103-104（extractFromBranch catch，git 不可用子进程）
 *   - loop-guard.mjs 162-163（summarizeToolInput catch，getter 抛错对象）
 *   - runtime.mjs 103-108（catch fail-open，只读状态目录）
 *   - bin/astra-hook.mjs 46（stdout error 非 EPIPE → fail-open exit 0）
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

const TEST_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-hook-fin-'));
process.env.ASTRA_HOOK_STATE_DIR = TEST_STATE;

test('FIN: decision-log — describePositive fallback (76) + describeNegative branches (79-85)', async () => {
  const { run } = await import('../src/runtime.mjs');

  // 76: '同意' 命中 positivePattern 但不含 '确认合并'/'Approved' → 兜底 '同意/通过'
  const r1 = await run('decision-log', JSON.stringify({ prompt: '我同意这个方案 #9999', hookEventName: 'UserPromptSubmit' }), {});
  assert.match(r1.hookSpecificOutput.permissionDecisionReason, /scheduled comment/);

  // 79-85: describeNegative 全分支
  const negatives = [
    '这个方案需要修改，重新设计吧 #9999',   // '重新设计' → '需要修改/重新设计'
    '驳回这个方案 #9999',                   // '驳回' → '拒绝/驳回'
    '暂缓处理 #9999',                       // '暂缓' → '暂缓/待澄清'
    '测试不通过 #9999',                     // '不通过' → '不通过'
    '拒绝这个方案 #9999',                   // 兜底 → '需要修改'
  ];
  for (const prompt of negatives) {
    const r = await run('decision-log', JSON.stringify({ prompt, hookEventName: 'UserPromptSubmit' }), {});
    assert.match(r.hookSpecificOutput.permissionDecisionReason, /scheduled comment/);
  }
  // 等待全部 setImmediate 后台回调（gh 对 9999 静默失败）
  await new Promise((res) => setTimeout(res, 200));
});

test('FIN: decision-log — extractFromBranch catch (103-104) via gitless PATH subprocess', () => {
  const gitlessBin = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-nogit2-'));
  const script = `
    process.env.PATH = ${JSON.stringify(gitlessBin)};
    process.env.ASTRA_HOOK_STATE_DIR = ${JSON.stringify(TEST_STATE)};
    const { run } = await import(${JSON.stringify(path.join(ROOT, 'src', 'runtime.mjs'))});
    // 无 #N/issue N → branch-resolve 路径 → 后台 extractFromBranch → git ENOENT → catch → null
    const r = await run('decision-log', JSON.stringify({ prompt: 'Approved 这个方案', hookEventName: 'UserPromptSubmit' }), {});
    console.log('REASON:' + r.hookSpecificOutput.permissionDecisionReason);
    await new Promise((res) => setTimeout(res, 300));
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 15000, cwd: ROOT,
  });
  assert.match(res.stdout, /branch-resolve/, 'no issue number in prompt → branch-resolve scheduled');
  // 后台 extractFromBranch catch 执行（git ENOENT），进程仍 exit 0
  assert.equal(res.status, 0);
});

test('FIN: loop-guard — summarizeToolInput catch (162-163) via getter-throwing toolInput', async () => {
  const loopGuard = (await import('../src/hooks/loop-guard.mjs')).default;
  const { clearState } = await import('../src/lib/state.mjs');
  const s = 'fin-getter-throw';
  clearState('loop-guard', s);
  // getter 抛错对象：Object.entries 枚举时抛错 → summarizeToolInput catch → '[unserializable]'
  // JSON.stringify 同样抛错 → stableFingerprint catch → String(obj)（指纹稳定）
  const evil = {};
  Object.defineProperty(evil, 'k', { enumerable: true, get() { throw new Error('boom'); } });
  const meta = { exemptTools: [], threshold: 3, maxHistory: 50 };
  let last;
  for (let i = 0; i < 3; i++) {
    last = await loopGuard({ toolName: 'evil-tool', toolInput: evil, sessionId: s, hookEventName: 'PreToolUse' }, meta, {});
  }
  assert.equal(last.hookSpecificOutput.permissionDecision, 'deny', 'getter-throwing input must not crash; 3rd call intercepted');
  assert.match(last.hookSpecificOutput.permissionDecisionReason, /\[unserializable\]/);
});

test('FIN: runtime — catch fail-open (103-108) via unwritable state dir', async () => {
  const ro = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-ro-fin-'));
  fs.chmodSync(ro, 0o555); // 只读 → updateState 的 mkdirSync/writeFile 抛 EACCES
  process.env.ASTRA_HOOK_STATE_DIR = ro;
  try {
    const { run } = await import('../src/runtime.mjs');
    const r = await run('loop-guard', JSON.stringify({ sessionId: 'fin-ro', toolName: 't', hookEventName: 'PreToolUse' }), {});
    assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
    assert.equal(r.hookSpecificOutput.permissionDecisionReason, 'astra-hook: runtime fail-open');
  } finally {
    fs.chmodSync(ro, 0o755);
    process.env.ASTRA_HOOK_STATE_DIR = TEST_STATE;
  }
});

test('FIN: bin — stdout error (non-EPIPE) → fail-open exit 0 (46, #957 refactor)', () => {
  // 子进程内劫持 process.stdout.on 捕获 error handler，手动注入非 EPIPE 错误，
  // 验证 handler 走 fail-open exit 0（而非 throw 导致崩溃）
  const script = `
    const origOn = process.stdout.on.bind(process.stdout);
    let errorHandler = null;
    process.stdout.on = function (event, handler) {
      if (event === 'error') { errorHandler = handler; return this; }
      return origOn(event, handler);
    };
    process.argv[2] = 'loop-guard';
    await import(${JSON.stringify(BIN)});
    process.stdin.emit('data', JSON.stringify({ sessionId: 'x', hookEventName: 'PreToolUse' }));
    process.stdin.emit('end');
    await new Promise((r) => setImmediate(r));
    if (errorHandler) errorHandler(Object.assign(new Error('boom'), { code: 'EBADF' }));
    // 若 handler 正确 exit 0，此行不可达
    console.log('HANDLER_DID_NOT_EXIT');
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 15000, cwd: ROOT,
    env: { ...process.env, ASTRA_HOOK_STATE_DIR: TEST_STATE },
  });
  assert.equal(res.status, 0, 'non-EPIPE stdout error must still exit 0 (fail-open)');
  assert.doesNotMatch(res.stdout, /HANDLER_DID_NOT_EXIT/, 'handler must exit before returning');
  assert.match(res.stderr, /stdout error/, 'error must be logged to stderr');
});
