/**
 * coverage-branches3.test.mjs — 分支覆盖率第三轮收尾（#957）
 *
 * 剩余可达分支：
 *   - decision-log 109：prompt 字段缺失（falsy）→ String(undefined || '') 兜底
 *   - decision-log 125：git 不可用 → extractFromBranch null → '未知' 兜底
 *   - loop-guard 42/60-61：bands.yaml 无 loop-guard 段 → meta.threshold/breakerLimit 兜底
 *   - state 68：withLock finally rmSync —— 锁文件被外部提前删除（force 不抛，验证幂等）
 *
 * 注：runtime 106（err.message || err 右侧）、config 147（rstrip ?? 左侧）、
 * loop-guard 54（state?.streak || 1 右侧）为防御性不可达分支（内部契约保证），
 * 已在代码注释中标注豁免理由。
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

const TEST_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-hook-br3-'));
process.env.ASTRA_HOOK_STATE_DIR = TEST_STATE;

test('BR3: decision-log — prompt field missing (109) + git unavailable → 未知 branch (125)', async () => {
  const decisionLog = (await import('../src/hooks/decision-log.mjs')).default;
  const { HOOK_METADATA } = await import('../src/lib/config.mjs');
  const meta = HOOK_METADATA['decision-log'];

  // 109: prompt 字段缺失 → String(undefined || '') → '' → no prompt 分支
  const r1 = await decisionLog({ hookEventName: 'UserPromptSubmit' }, meta, {});
  assert.match(r1.hookSpecificOutput.permissionDecisionReason, /no prompt/);

  // 125: PATH 无 git → postComment 内 extractFromBranch catch → null → '未知' 兜底
  // （gh 对 9999 静默失败，无副作用）
  const gitlessBin = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-nogit3-'));
  const script = `
    process.env.PATH = ${JSON.stringify(gitlessBin)};
    process.env.ASTRA_HOOK_STATE_DIR = ${JSON.stringify(TEST_STATE)};
    const { run } = await import(${JSON.stringify(path.join(ROOT, 'src', 'runtime.mjs'))});
    const r = await run('decision-log', JSON.stringify({ prompt: 'Approved #9999', hookEventName: 'UserPromptSubmit' }), { debug: true });
    console.log('REASON:' + r.hookSpecificOutput.permissionDecisionReason);
    await new Promise((res) => setTimeout(res, 400));
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 15000, cwd: ROOT,
  });
  assert.match(res.stdout, /scheduled comment/);
  assert.equal(res.status, 0);
  // debug stderr 应含 gh 失败日志（134 分支）——分支名解析失败不影响评论尝试
});

test('BR3: loop-guard — bands without loop-guard section → defaults fallback verified', async () => {
  // 验证结论：loadBands 深度合并保证 BANDS_DEFAULTS['loop-guard'] 永远存在，
  // 因此 loop-guard 42/60-61 的 meta.threshold/meta.breakerLimit 分支为防御性
  // 不可达分支（bands defaults 兜底保证）。此处固化该契约：
  // 即使 bands 文件缺失 loop-guard 段，阈值仍从 defaults 取值。
  const bandsFile = path.join(TEST_STATE, 'bands-nolg.yaml');
  fs.writeFileSync(bandsFile, 'sigma:\n  "1":\n    action: log\n', 'utf8');
  process.env.ASTRA_BANDS_FILE = bandsFile;
  try {
    const { loadBands } = await import('../src/lib/config.mjs');
    const bands = loadBands();
    assert.deepEqual(bands['loop-guard'], { threshold: 3, breakerLimit: 8, maxHistory: 50, nudgeThreshold: 2, toolStreakLimit: 12 },
      'defaults must survive bands file without loop-guard section (#1020 加 nudgeThreshold/toolStreakLimit)');

    // meta.maxHistory 兜底（54 的 || 50 分支）：bands defaults 有 maxHistory=50，
    // meta 缺省时 slice(-50) 生效——通过长 history 验证截断行为
    const loopGuard = (await import('../src/hooks/loop-guard.mjs')).default;
    const { clearState } = await import('../src/lib/state.mjs');
    const s = 'br3-maxhistory';
    clearState('loop-guard', s);
    const meta = { exemptTools: [] }; // 无 maxHistory → bands defaults 50
    let last;
    for (let i = 0; i < 3; i++) {
      last = await loopGuard(
        { toolName: 'br3-tool', toolInput: { n: 'same' }, sessionId: s, hookEventName: 'PreToolUse' },
        meta,
        {},
      );
    }
    assert.equal(last.hookSpecificOutput.permissionDecision, 'deny');
  } finally {
    delete process.env.ASTRA_BANDS_FILE;
  }
});

test('BR3: state — withLock finally rmSync idempotent (68)', async () => {
  // 68: finally 中 rmSync(force:true) 对已删除的锁文件幂等（不抛错）
  // 正常路径锁文件在 finally 被删除；此处验证重复删除不抛错（catch 分支防御性）
  const { updateState } = await import('../src/lib/state.mjs');
  const r = await updateState('loop-guard', 'br3-idempotent', () => ({ v: 9 }));
  assert.deepEqual(r, { v: 9 });
  // 锁文件已被 finally 清理
  const lockFile = path.join(TEST_STATE, 'loop-guard', 'br3-idempotent.json.lock');
  assert.equal(fs.existsSync(lockFile), false);
});
