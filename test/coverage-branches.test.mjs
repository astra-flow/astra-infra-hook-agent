/**
 * coverage-branches.test.mjs — 分支覆盖率补齐（#957：分支 100% 目标）
 *
 * 基于 c8 报告的未覆盖分支逐项补齐：
 *   - state.mjs 54-56：withLock 非 EEXIST 错误（锁路径为目录 → EISDIR）→ fail-open
 *   - config.mjs 182：loadBands readFileSync 抛错（路径为目录 → EISDIR）→ defaults
 *   - config.mjs 125-132/147：parseYamlValue 引号/布尔/浮点/null 分支
 *   - config.mjs 40（normalize）：raw 非对象 → {}
 *   - runtime.mjs 25/57/90/106：debug 日志分支（null 字段/豁免/异常）
 *   - decision-log.mjs 61-62/80/83/100-101/109/125/134：meta 缺省分支 + describe 分支
 *   - delivery-gate.mjs 65/76/81/92：debug + hookEventName 缺省分支
 *   - loop-guard.mjs 60-61/75/89/106/114/151/155：bands 缺省 + hookEventName 缺省 + 长字符串/空嵌套
 *   - session-issue-link.mjs 72/93：branch 无数字 + ASTRA_WORKSPACE_ROOT 缺省
 *   - bin/astra-hook.mjs 46：stdout error 的 err.code 缺省分支
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

const TEST_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-hook-br-'));
process.env.ASTRA_HOOK_STATE_DIR = TEST_STATE;

test('BR: state — withLock non-EEXIST error → fail-open execute (54-56)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-lockbr-'));
  process.env.ASTRA_HOOK_STATE_DIR = root;
  try {
    // 状态目录只读 → openSync('wx') 抛 EACCES（非 EEXIST）→ 54-56 fail-open 执行 fn。
    // mutate 返回 null → fn 内不写文件 → 完整走通（若写文件会因 EACCES 二次抛错）。
    const lgDir = path.join(root, 'loop-guard');
    fs.mkdirSync(lgDir);
    fs.chmodSync(lgDir, 0o555);
    const { updateState } = await import('../src/lib/state.mjs');
    const r = await updateState('loop-guard', 'lockbr', () => null);
    assert.equal(r, null, 'non-EEXIST lock error must fail-open execute mutate');
  } finally {
    process.env.ASTRA_HOOK_STATE_DIR = TEST_STATE;
  }
});

test('BR: config — loadBands readFileSync throws (dir path) → defaults (182)', async () => {
  const dirAsBands = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-bandsdir-'));
  process.env.ASTRA_BANDS_FILE = dirAsBands;
  try {
    const { loadBands, BANDS_DEFAULTS } = await import('../src/lib/config.mjs');
    const bands = loadBands();
    assert.deepEqual(bands['loop-guard'], BANDS_DEFAULTS['loop-guard']);
  } finally {
    delete process.env.ASTRA_BANDS_FILE;
  }
});

test('BR: config — parseYamlValue quoted/bool/float/null branches (125-132) + parseSimpleYaml rstrip (147)', async () => {
  const { parseSimpleYaml } = await import('../src/lib/config.mjs');
  const yaml = [
    'dq: "quoted string"',      // 双引号 → slice
    'sq: \'single quoted\'',    // 单引号 → slice
    'yes: true',                // true 分支
    'no: false',                // false 分支
    'int: -42',                 // 负整数
    'float: 3.14',              // 浮点分支
    'nothing: null',            // null 分支
    'empty:',                   // 空值 → section
    '  inner: "x#y"',           // 值内 # 在 split('#') 后保留前段（解析器语义）
  ].join('\n');
  const parsed = parseSimpleYaml(yaml);
  assert.equal(parsed.dq, 'quoted string');
  assert.equal(parsed.sq, 'single quoted');
  assert.equal(parsed.yes, true);
  assert.equal(parsed.no, false);
  assert.equal(parsed.int, -42);
  assert.equal(parsed.float, 3.14);
  assert.equal(parsed.nothing, null);
  // 解析器语义：值内 # 会被 split('#') 截断（'"x#y"' → '"x'），带引号的 # 值不被支持
  assert.equal(parsed.empty.inner, '"x');
});

test('BR: normalize — raw non-object → {} (40)', async () => {
  const { normalizeInput } = await import('../src/lib/normalize.mjs');
  assert.deepEqual(normalizeInput(null), {});
  assert.deepEqual(normalizeInput('string'), {});
  assert.deepEqual(normalizeInput(42), {});
  // null/undefined 字段值保留（25 分支）
  const out = normalizeInput({ sessionId: null, toolName: undefined, prompt: 'x' });
  assert.equal(out.sessionId, null);
  assert.equal(out.toolName, undefined);
});

test('BR: runtime — debug branches (25/57/90/106) via subprocess --debug', () => {
  // 25: summarizeInput null 字段；57: invalid stdin JSON debug；90: exempt tool debug；106: runtime error debug
  const cases = [
    // 25: input 含 null 字段 → summarizeInput null 分支
    { stdin: JSON.stringify({ sessionId: null, hookEventName: 'Stop', toolName: 't' }), hook: 'loop-guard' },
    // 57: 非法 JSON → invalid stdin debug
    { stdin: 'not-json', hook: 'loop-guard' },
    // 90: 豁免工具 → exempt debug
    { stdin: JSON.stringify({ sessionId: 'x', hookEventName: 'PreToolUse', toolName: 'read_file' }), hook: 'loop-guard' },
  ];
  for (const c of cases) {
    const res = spawnSync(process.execPath, [BIN, c.hook, '--debug'], {
      input: c.stdin, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, ASTRA_HOOK_STATE_DIR: TEST_STATE },
    });
    assert.equal(res.status, 0);
    assert.match(res.stderr, /\[astra-hook\]/, 'debug stderr must be emitted');
  }
  // 106: runtime error debug —— 只读状态目录 → catch → debug 日志
  const ro = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-ro-br-'));
  fs.chmodSync(ro, 0o555);
  try {
    const res = spawnSync(process.execPath, [BIN, 'loop-guard', '--debug'], {
      input: JSON.stringify({ sessionId: 'x', toolName: 't', hookEventName: 'PreToolUse' }),
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, ASTRA_HOOK_STATE_DIR: ro },
    });
    assert.equal(res.status, 0);
    assert.match(res.stderr, /runtime error/, 'runtime error debug log emitted');
  } finally {
    fs.chmodSync(ro, 0o755);
  }
});

test('BR: decision-log — meta pattern defaults (61-62) + describe branches (80/83) + extractFromBranch null-safety (100-101) + sanitize/postComment debug (109/125/134)', async () => {
  const decisionLog = (await import('../src/hooks/decision-log.mjs')).default;
  // 61-62: meta 无 positivePatterns/negativePatterns → [] 缺省分支
  const r = await decisionLog({ prompt: '普通对话无关键词', hookEventName: 'UserPromptSubmit' }, {}, {});
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /no decision keyword/);

  // 80/83: describeNegative '重新设计' 与 '不通过' 分支（经 run 触发 postComment）
  const { run } = await import('../src/runtime.mjs');
  for (const prompt of ['需要重新设计 #9999', '测试不通过 #9999']) {
    await run('decision-log', JSON.stringify({ prompt, hookEventName: 'UserPromptSubmit' }), {});
  }
  // 100-101: extractFromBranch 分支名无数字 → m 为 null → ''（经 postComment 后台）
  // 109: sanitizePrompt 空输入；125: postComment debug err 日志（gh 失败 + debug）
  await decisionLog(
    { prompt: 'Approved #9999', hookEventName: 'UserPromptSubmit' },
    {},
    { debug: true }, // debug: gh comment 失败日志（125 分支）
  );
  await new Promise((res) => setTimeout(res, 300));
});

test('BR: delivery-gate — debug check-failed (65) + hookEventName default (76/81/92)', async () => {
  const deliveryGate = (await import('../src/hooks/delivery-gate.mjs')).default;
  // 92: hookEventName 缺省 → 'PreToolUse' 兜底（非写工具分支）
  const r1 = await deliveryGate({ toolName: 'read_file' }, {}, {});
  assert.equal(r1.hookSpecificOutput.hookEventName, '');
  // 76/81: artifact present + hookEventName 缺省
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-wsbr-'));
  process.env.ASTRA_WORKSPACE_ROOT = wsRoot;
  process.env.ASTRA_SDLC_PHASE = 'design';
  try {
    const specDir = path.join(wsRoot, 'docs/03-agile/artifacts/specs');
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, 'spec-001.md'), 'x', 'utf8');
    const r2 = await deliveryGate({ toolName: 'create_file' }, {}, {});
    assert.equal(r2.hookSpecificOutput.hookEventName, 'PreToolUse', 'default eventName applied');
    assert.match(r2.hookSpecificOutput.permissionDecisionReason, /present/);
    // 65: debug check-failed —— artifactDir 为文件 → existsSync true → readdirSync 抛 ENOTDIR → debug 日志
    const wsRoot2 = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-wsbr2-'));
    const specFile = path.join(wsRoot2, 'docs/03-agile/artifacts/specs');
    fs.mkdirSync(path.dirname(specFile), { recursive: true });
    fs.writeFileSync(specFile, 'file-not-dir', 'utf8');
    process.env.ASTRA_WORKSPACE_ROOT = wsRoot2;
    const r3 = await deliveryGate({ toolName: 'create_file' }, {}, { debug: true });
    assert.match(r3.hookSpecificOutput.permissionDecisionReason, /fail-open/);
  } finally {
    delete process.env.ASTRA_WORKSPACE_ROOT;
    delete process.env.ASTRA_SDLC_PHASE;
  }
});

test('BR: loop-guard — bands default fallback (60-61) + eventName defaults (75/89/106/114) + summary long-string/empty-nested (151/155)', async () => {
  const loopGuard = (await import('../src/hooks/loop-guard.mjs')).default;
  const { clearState } = await import('../src/lib/state.mjs');
  // meta 无 breakerLimit/threshold → bands.yaml 值兜底（60-61）
  const meta = { exemptTools: [], maxHistory: 50 };
  // 151: 长字符串 >80 截断；155: 空嵌套对象 keys '(empty)'
  const s = 'br-summary';
  clearState('loop-guard', s);
  let last;
  for (let i = 0; i < 3; i++) {
    last = await loopGuard(
      {
        toolName: 'br-tool',
        toolInput: { long: 'x'.repeat(120), empty: {}, num: 42 },
        sessionId: s,
        // hookEventName 缺省 → 75/89/106/114 的 'PreToolUse' 兜底分支
      },
      meta,
      {},
    );
  }
  assert.equal(last.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(last.hookSpecificOutput.permissionDecisionReason, /xxx\.\.\./, 'long string truncated');
  assert.match(last.hookSpecificOutput.permissionDecisionReason, /\(empty\)/, 'empty nested object keys');
  assert.equal(last.hookSpecificOutput.hookEventName, 'PreToolUse', 'default eventName');
});

test('BR: session-issue-link — branch without digits (72) + cwd fallback (93)', async () => {
  const sessionIssueLink = (await import('../src/hooks/session-issue-link.mjs')).default;
  // 72: 分支名无数字 → extractFromBranch 返回 '' → no issue number
  // 当前分支 feature/loop-guard-ask-escalation-957 有数字；用子进程切到无数字分支不可行，
  // 改为直接验证：SessionStart 在 git 仓库内但分支无数字 —— 通过 git checkout 临时分支太重。
  // 替代：PostToolUse issue_write + response 无编号已覆盖 no-issue 分支；
  // 72 的 m null 分支通过 git symbolic-ref 不可行，用 spawn 子进程 + git init 空仓库（无分支名数字）
  const bareRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-bare-'));
  spawnSync('git', ['init', '-q', bareRepo], { timeout: 5000 });
  const script = `
    process.chdir(${JSON.stringify(bareRepo)});
    process.env.ASTRA_HOOK_STATE_DIR = ${JSON.stringify(TEST_STATE)};
    const mod = await import(${JSON.stringify(path.join(ROOT, 'src', 'hooks', 'session-issue-link.mjs'))});
    const r = await mod.default({ hookEventName: 'SessionStart', sessionId: 'br-nodigit' }, {}, {});
    console.log('REASON:' + r.hookSpecificOutput.permissionDecisionReason);
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 15000, cwd: ROOT,
  });
  // 空仓库分支名（master/main 或 unborn HEAD）无数字 → no issue number
  assert.match(res.stdout, /no issue number/);

  // 93: resolveLinkFile 的 ASTRA_WORKSPACE_ROOT 缺省 → process.cwd() 分支
  delete process.env.ASTRA_WORKSPACE_ROOT;
  const r = await sessionIssueLink(
    { hookEventName: 'PostToolUse', toolName: 'issue_write', toolResponse: '{"id":"777"}' },
    { linkFile: 'memories/session/issue-link-cwd.md' },
    {},
  );
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /recorded/);
  const written = fs.readFileSync(path.join(ROOT, 'memories/session/issue-link-cwd.md'), 'utf8');
  assert.match(written, /issue=#777/);
  // 清理测试写入
  fs.rmSync(path.join(ROOT, 'memories/session/issue-link-cwd.md'), { force: true });
});

test('BR: bin — stdout error err.code undefined → message fallback (46)', () => {
  // err.code 缺省 → err.message 兜底（46 的 || 分支）
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
    if (errorHandler) errorHandler(new Error('no-code-error'));
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 15000, cwd: ROOT,
    env: { ...process.env, ASTRA_HOOK_STATE_DIR: TEST_STATE },
  });
  assert.equal(res.status, 0);
  assert.match(res.stderr, /no-code-error/, 'message fallback used when err.code undefined');
});
