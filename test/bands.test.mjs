/**
 * bands.test.mjs — bands.yaml 加载 evals（#916：σ 分级边界可调配置）
 *
 * 覆盖：
 *   1. 默认加载（config/bands.yaml 存在）→ 值正确
 *   2. 文件缺失 → 内置默认值兜底（fail-open）
 *   3. env ASTRA_BANDS_FILE 覆盖 → 自定义阈值生效
 *   4. 解析失败（非法内容）→ 默认值兜底
 *   5. loop-guard 集成：bands threshold 生效
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadBands, parseSimpleYaml, BANDS_DEFAULTS } from '../src/lib/config.mjs';
import { run } from '../src/runtime.mjs';
import { clearState } from '../src/lib/state.mjs';

const TEST_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-bands-'));
process.env.ASTRA_HOOK_STATE_DIR = TEST_STATE;

test('BANDS: default load from config/bands.yaml', () => {
  const bands = loadBands();
  assert.equal(bands['loop-guard'].threshold, 3);
  assert.equal(bands['loop-guard'].breakerLimit, 8);
  assert.equal(bands['loop-guard'].maxHistory, 50);
  assert.equal(bands.sigma['3'].action, 'act');
});

test('BANDS: missing file → defaults fallback (fail-open)', () => {
  process.env.ASTRA_BANDS_FILE = '/nonexistent/bands.yaml';
  const bands = loadBands();
  assert.deepEqual(bands, BANDS_DEFAULTS);
  delete process.env.ASTRA_BANDS_FILE;
});

test('BANDS: env override → custom thresholds', () => {
  const custom = path.join(TEST_STATE, 'custom-bands.yaml');
  fs.writeFileSync(custom, [
    'sigma:',
    '  "1":',
    '    action: log',
    '  "2":',
    '    action: diagnose',
    '  "3":',
    '    action: act',
    'loop-guard:',
    '  threshold: 5',
    '  breakerLimit: 12',
    '  maxHistory: 100',
  ].join('\n'), 'utf8');
  process.env.ASTRA_BANDS_FILE = custom;
  const bands = loadBands();
  assert.equal(bands['loop-guard'].threshold, 5);
  assert.equal(bands['loop-guard'].breakerLimit, 12);
  assert.equal(bands['loop-guard'].maxHistory, 100);
  delete process.env.ASTRA_BANDS_FILE;
});

test('BANDS: invalid yaml → defaults fallback', () => {
  const bad = path.join(TEST_STATE, 'bad-bands.yaml');
  fs.writeFileSync(bad, '::::not yaml at all::::\n\x00\x01', 'utf8');
  process.env.ASTRA_BANDS_FILE = bad;
  const bands = loadBands();
  assert.deepEqual(bands, BANDS_DEFAULTS);
  delete process.env.ASTRA_BANDS_FILE;
});

test('BANDS: parseSimpleYaml handles comments and quotes', () => {
  const parsed = parseSimpleYaml([
    '# comment',
    'loop-guard:',
    '  threshold: 4  # inline comment',
    '  breakerLimit: "10"',
  ].join('\n'));
  assert.equal(parsed['loop-guard'].threshold, 4);
  assert.equal(parsed['loop-guard'].breakerLimit, 10);
});

test('BANDS: loop-guard integration — bands threshold takes effect', async () => {
  const custom = path.join(TEST_STATE, 'int-bands.yaml');
  fs.writeFileSync(custom, [
    'sigma:',
    '  "1":',
    '    action: log',
    '  "2":',
    '    action: diagnose',
    '  "3":',
    '    action: act',
    'loop-guard:',
    '  threshold: 2',
    '  breakerLimit: 4',
    '  maxHistory: 50',
  ].join('\n'), 'utf8');
  process.env.ASTRA_BANDS_FILE = custom;

  const SESSION = 'bands-int-session';
  clearState('loop-guard', SESSION);
  const mk = () => JSON.stringify({
    sessionId: SESSION,
    toolName: 'mcp_github_mcp_se_add_issue_comment',
    toolInput: { body: 'bands-test', issue_number: 1, owner: 'o', repo: 'r' },
    hookEventName: 'PreToolUse',
  });
  // threshold=2：第 2 次即 deny（默认 3 次才 deny）
  await run('loop-guard', mk(), {});
  const r2 = await run('loop-guard', mk(), {});
  assert.equal(r2.hookSpecificOutput.permissionDecision, 'deny', 'bands threshold=2 should deny at 2nd call');
  delete process.env.ASTRA_BANDS_FILE;
  clearState('loop-guard', SESSION);
});
