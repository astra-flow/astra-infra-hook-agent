/**
 * coverage-branches2.test.mjs — 分支覆盖率最终收尾（#957）
 *
 * 剩余分支（基于 c8 报告）：
 *   - loop-guard 42/50/54/60-61/75/89：meta 缺省值兜底分支 + ask/breaker 路径 eventName 兜底
 *   - state 25/35/68/115：homedir 缺省 / sanitizeId default / rmSync catch
 *   - decision-log 83/100-101/109/125/134：describeNegative 兜底 / branch 无数字 /
 *     prompt 空兜底 / debug gh 失败日志 / child.on error
 *   - delivery-gate 65/92：ASTRA_WORKSPACE_ROOT 缺省 cwd 分支 / eventName 兜底
 *   - runtime 106：debug runtime error（err.message 缺省分支）
 *   - config 147/182：rstrip ?? 分支 / loadBands catch
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

const TEST_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-hook-br2-'));
process.env.ASTRA_HOOK_STATE_DIR = TEST_STATE;

test('BR2: loop-guard — meta fallbacks (42/50/54/60-61) + ask/breaker eventName default (75/89)', async () => {
  const loopGuard = (await import('../src/hooks/loop-guard.mjs')).default;
  const { clearState, updateState } = await import('../src/lib/state.mjs');

  // 42: meta.threshold 兜底分支 —— 需 bands.yaml 无 loop-guard.threshold。
  // bands.yaml 有值（3），因此 meta.threshold 分支在当前配置下不可达；
  // 但 42 的 || 链第三分支（硬编码 3）可通过 bands+meta 均无值触发——同样被 bands 挡住。
  // 可达策略：直接调用 + meta.maxHistory 缺省（54）+ 预置畸形 state（50）。
  const s = 'br2-meta-fallback';
  clearState('loop-guard', s);
  // 预置 state：有 history 但无 streak/lastFp（50 分支：prev.streak 缺省 → 0）
  await updateState('loop-guard', s, () => ({ history: ['a', 'b'] }));
  const meta = { exemptTools: [] }; // 无 threshold/maxHistory/breakerLimit（54/60-61 兜底）
  let last;
  for (let i = 0; i < 8; i++) {
    last = await loopGuard(
      { toolName: 'br2-tool', toolInput: { n: 'same' }, sessionId: s, hookEventName: 'PreToolUse' },
      meta,
      {},
    );
  }
  // streak=8 >= breakerLimit(8) → ask 兜底（75/89 中 breaker 路径 eventName 兜底已覆盖）
  assert.equal(last.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(last.hookSpecificOutput.permissionDecisionReason, /熔断/);

  // 75: 熔断路径 eventName 兜底（hookEventName 缺省 + streak>=breakerLimit）
  const s2 = 'br2-ask-default-event';
  clearState('loop-guard', s2);
  let last2;
  for (let i = 0; i < 8; i++) {
    last2 = await loopGuard(
      { toolName: 'br2-tool2', toolInput: { n: 'same' }, sessionId: s2 }, // 无 hookEventName
      meta,
      {},
    );
  }
  assert.equal(last2.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(last2.hookSpecificOutput.permissionDecisionReason, /熔断/, 'breaker path reached');
  assert.equal(last2.hookSpecificOutput.hookEventName, 'PreToolUse', 'default eventName in breaker path');

  // 89: 升级路径 eventName 兜底（hookEventName 缺省 + askThreshold<=streak<breakerLimit）
  const s3 = 'br2-escalate-default-event';
  clearState('loop-guard', s3);
  let last3;
  for (let i = 0; i < 5; i++) {
    last3 = await loopGuard(
      { toolName: 'br2-tool3', toolInput: { n: 'same' }, sessionId: s3 }, // 无 hookEventName
      meta,
      {},
    );
  }
  assert.equal(last3.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(last3.hookSpecificOutput.permissionDecisionReason, /人工审批/, 'escalation path reached');
  assert.equal(last3.hookSpecificOutput.hookEventName, 'PreToolUse', 'default eventName in escalation path');
});

test('BR2: state — homedir default (25) + sanitizeId default (35) + rmSync catch (68/115)', async () => {
  // 25: ASTRA_HOOK_STATE_DIR 缺省 → homedir 分支（子进程内不设 env）
  // 35: sanitizeId('') → 'default'
  // 68: withLock finally rmSync catch —— 锁文件在 fn 执行前被移除
  // 115: clearState rmSync catch —— 状态文件路径是目录 → rmSync force 对目录抛 ERR_FS_EISDIR
  const script = `
    delete process.env.ASTRA_HOOK_STATE_DIR; // 25: homedir 分支
    const { stateRoot, clearState, updateState } = await import(${JSON.stringify(path.join(ROOT, 'src', 'lib', 'state.mjs'))});
    console.log('ROOT_HAS_ASTRA:' + stateRoot().includes('.astra'));
    console.log('SANITIZE_DEFAULT:' + (await updateState('loop-guard', '', () => ({ v: 1 }))).v); // 35: '' → 'default'
    // 115: clearState 对目录路径 → rmSync force 抛 ERR_FS_EISDIR → catch 吞掉
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const dirTarget = path.join(os.homedir(), '.astra', 'hooks', 'loop-guard', 'br2-dir-target.json');
    fs.mkdirSync(dirTarget, { recursive: true });
    clearState('loop-guard', 'br2-dir-target'); // 115 catch
    fs.rmdirSync(dirTarget);
    console.log('DONE');
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 15000, cwd: ROOT,
  });
  assert.match(res.stdout, /ROOT_HAS_ASTRA:true/);
  assert.match(res.stdout, /SANITIZE_DEFAULT:1/);
  assert.match(res.stdout, /DONE/);
  assert.equal(res.status, 0);
  // 清理 homedir 下的 default 状态文件
  fs.rmSync(path.join(os.homedir(), '.astra', 'hooks', 'loop-guard', 'default.json'), { force: true });
});

test('BR2: decision-log — describeNegative fallback (83) + branch no-digit (100-101) + empty prompt (109) + debug gh fail (134) + child error handler', async () => {
  const decisionLog = (await import('../src/hooks/decision-log.mjs')).default;
  const { HOOK_METADATA } = await import('../src/lib/config.mjs');
  const meta = HOOK_METADATA['decision-log']; // 完整 meta：patterns 必须存在才能命中关键词
  const { run } = await import('../src/runtime.mjs');

  // 83: describeNegative 兜底 '需要修改' —— '拒绝' 命中 negativePattern 但不含其他关键词
  // 134: debug + gh 失败 → console.error（gh 对 9999 静默失败）
  const r1 = await decisionLog(
    { prompt: '拒绝 #9999', hookEventName: 'UserPromptSubmit' },
    meta,
    { debug: true },
  );
  assert.match(r1.hookSpecificOutput.permissionDecisionReason, /scheduled comment/);

  // 109: sanitizePrompt 空输入兜底 —— 空白 prompt 走 no decision keyword 分支
  const r2 = await decisionLog({ prompt: '   ', hookEventName: 'UserPromptSubmit' }, meta, {});
  assert.match(r2.hookSpecificOutput.permissionDecisionReason, /no decision keyword/);

  // 100-101: extractFromBranch 分支名无数字 → m null → ''（空仓库子进程）
  const bareRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-bare2-'));
  spawnSync('git', ['init', '-q', bareRepo], { timeout: 5000 });
  const script = `
    process.chdir(${JSON.stringify(bareRepo)});
    process.env.ASTRA_HOOK_STATE_DIR = ${JSON.stringify(TEST_STATE)};
    const { run } = await import(${JSON.stringify(path.join(ROOT, 'src', 'runtime.mjs'))});
    // 无 #N → session-resolve → 后台会话关联（无记录）→ 分支名解析 → 无数字 → null → 不评论
    const r = await run('decision-log', JSON.stringify({ prompt: 'Approved 这个方案', hookEventName: 'UserPromptSubmit' }), {});
    console.log('REASON:' + r.hookSpecificOutput.permissionDecisionReason);
    await new Promise((res) => setTimeout(res, 300));
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 15000, cwd: ROOT,
  });
  assert.match(res.stdout, /session-resolve/);
  assert.equal(res.status, 0);
});

// delivery-gate 已删除（#976），其分支覆盖由 delivery-hooks.test.mjs 承载

test('BR2: runtime — debug runtime error message fallback (106)', async () => {
  // 106: err?.message || err —— message 缺省分支（Error 无 message → err 本身）
  // 只读状态目录 + debug → catch → console.error（message 存在，走 || 左侧）
  // 右侧分支（err 无 message）通过抛非 Error 值触发——runtime 内部抛的都是 Error，
  // 右侧分支不可达，但 || 表达式两侧已由 debug 测试覆盖左侧；此处验证 debug 日志输出。
  const ro = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-ro-br2-'));
  fs.chmodSync(ro, 0o555);
  try {
    const res = spawnSync(process.execPath, [BIN, 'loop-guard', '--debug'], {
      input: JSON.stringify({ sessionId: 'br2-ro', toolName: 't', hookEventName: 'PreToolUse' }),
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, ASTRA_HOOK_STATE_DIR: ro },
    });
    assert.equal(res.status, 0);
    assert.match(res.stderr, /runtime error: .+, fail-open/);
  } finally {
    fs.chmodSync(ro, 0o755);
  }
});

test('BR2: config — rstrip ?? branch (147) + loadBands catch (182) re-verify', async () => {
  const { parseSimpleYaml, loadBands, BANDS_DEFAULTS } = await import('../src/lib/config.mjs');
  // 147: rstrip?.() —— String.prototype 无 rstrip → undefined → ?? 右侧 replace 分支
  // 带尾随空格 + 注释的行
  const parsed = parseSimpleYaml('key: value   # comment  \n');
  assert.equal(parsed.key, 'value');
  // 182: loadBands catch —— ASTRA_BANDS_FILE 指向目录 → readFileSync EISDIR → catch
  const dirAsBands = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-bandsdir2-'));
  process.env.ASTRA_BANDS_FILE = dirAsBands;
  try {
    const bands = loadBands();
    assert.deepEqual(bands['loop-guard'], BANDS_DEFAULTS['loop-guard']);
  } finally {
    delete process.env.ASTRA_BANDS_FILE;
  }
});
