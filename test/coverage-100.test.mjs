/**
 * coverage-100.test.mjs — 覆盖率补齐（#957：新增/重构代码 100% 覆盖）
 *
 * 目标模块与未覆盖路径（基于 --experimental-test-coverage 基线）：
 *   - decision.mjs 48-58：buildCircuitBreaker（#899 遗留 API，仍被导出）
 *   - loop-guard.mjs 27-29（debug 日志）/ 131-132（stableFingerprint catch）/
 *     153-155（summarizeToolInput 非 object）/ 162-163（summarizeToolInput catch）
 *   - config.mjs 90-97（validateMetadataSchema）/ 157/164-165/169-170（parseSimpleYaml 分支）
 *   - validate.mjs 32-48（validateInput 各失败分支）
 *   - state.mjs 44-53（withLock 锁竞争/超时路径）
 *   - runtime.mjs 22-38（summarizeInput debug）/ 103-108（未知 hook/异常 fail-open）
 *   - decision-log.mjs / session-issue-link.mjs / delivery-gate.mjs 分支补齐
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const TEST_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-hook-cov-'));
process.env.ASTRA_HOOK_STATE_DIR = TEST_STATE;

// ---------- decision.mjs：buildCircuitBreaker（遗留导出 API） ----------
import { buildCircuitBreaker, buildDecision, buildAsk, buildDeny, buildAllow, FAIL_OPEN_DECISION } from '../src/lib/decision.mjs';

test('COV: buildCircuitBreaker legacy API shape (#899 export retained)', () => {
  const out = buildCircuitBreaker('reason-ui', 'system-msg', 'PreToolUse');
  assert.equal(out.continue, false);
  assert.equal(out.stopReason, 'system-msg');
  assert.equal(out.systemMessage, 'system-msg');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  // 默认 eventName
  const out2 = buildCircuitBreaker('r', 's');
  assert.equal(out2.hookSpecificOutput.hookEventName, 'PreToolUse');
});

test('COV: decision builders default eventName + systemMessage branches', () => {
  assert.equal(buildDecision('deny', 'r').hookSpecificOutput.hookEventName, '');
  assert.equal(buildAsk('r').hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(buildAsk('r', 'Evt', 'msg').systemMessage, 'msg');
  assert.equal(buildDeny('r').systemMessage, undefined, 'no systemMessage when empty');
  assert.equal(buildAllow('r').hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(FAIL_OPEN_DECISION.hookSpecificOutput.permissionDecision, 'allow');
});

// ---------- loop-guard.mjs：debug 日志 + summarizeToolInput 边界 ----------
import loopGuard from '../src/hooks/loop-guard.mjs';
import { clearState } from '../src/lib/state.mjs';

const LG_SESSION = 'cov-lg-session';

test('COV: loop-guard debug logging path (exempt tool)', async () => {
  const meta = { exemptTools: ['read_file'], threshold: 3, maxHistory: 50 };
  const r = await loopGuard(
    { toolName: 'read_file', toolInput: {}, sessionId: LG_SESSION, hookEventName: 'PreToolUse' },
    meta,
    { debug: true },
  );
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
});

test('COV: loop-guard no session → allow', async () => {
  const meta = { exemptTools: [], threshold: 3 };
  const r = await loopGuard({ toolName: 'x', toolInput: {}, hookEventName: 'PreToolUse' }, meta, {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /no session/);
});

test('COV: summarizeToolInput — non-object input + unserializable + nested object', async () => {
  // 根因说明：threshold 优先级为 bands.yaml > meta，直接调用时 meta.threshold=1
  // 不生效（bands.yaml threshold=3 胜出）。因此用 threshold=3 的默认值，
  // 连续调用 3 次进入拦截分支，reason 才含 summarizeToolInput 输出。
  const meta = { exemptTools: [], threshold: 3, maxHistory: 50 };

  // toolInput 为 null → summarizeToolInput 返回 '[unserializable]'（153-155）
  const s1 = `${LG_SESSION}-sum1`;
  clearState('loop-guard', s1);
  let r1;
  for (let i = 0; i < 3; i++) {
    r1 = await loopGuard({ toolName: 't1', toolInput: null, sessionId: s1, hookEventName: 'PreToolUse' }, meta, {});
  }
  assert.equal(r1.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r1.hookSpecificOutput.permissionDecisionReason, /\[unserializable\]/);

  // 嵌套对象 → {keys: ...}（162-163 分支）
  const s2 = `${LG_SESSION}-sum2`;
  clearState('loop-guard', s2);
  let r2;
  for (let i = 0; i < 3; i++) {
    r2 = await loopGuard(
      { toolName: 't2', toolInput: { nested: { a: 1 } }, sessionId: s2, hookEventName: 'PreToolUse' },
      meta,
      {},
    );
  }
  assert.match(r2.hookSpecificOutput.permissionDecisionReason, /keys: a/);

  // 循环引用 → stableFingerprint 的 JSON.stringify 抛错 → catch → String(obj)
  // （131-132 fingerprint 层 catch）；summarizeToolInput 对 cyclic 走 {keys:...}
  // 分支（Object.entries 不 stringify，不抛错）。断言两层行为均正确。
  const s3 = `${LG_SESSION}-sum3`;
  clearState('loop-guard', s3);
  const cyclic = {}; cyclic.self = cyclic;
  let r3;
  for (let i = 0; i < 3; i++) {
    r3 = await loopGuard({ toolName: 't3', toolInput: cyclic, sessionId: s3, hookEventName: 'PreToolUse' }, meta, {});
  }
  assert.equal(r3.hookSpecificOutput.permissionDecision, 'deny', 'cyclic input must not crash; 3rd identical call intercepted');
  assert.match(r3.hookSpecificOutput.permissionDecisionReason, /keys: self/, 'summarize handles cyclic via keys branch');
});

// ---------- config.mjs：validateMetadataSchema + parseSimpleYaml 分支 ----------
import { validateMetadataSchema, parseSimpleYaml, loadBands, BANDS_DEFAULTS } from '../src/lib/config.mjs';

test('COV: validateMetadataSchema valid schema', () => {
  const { valid, errors } = validateMetadataSchema();
  assert.equal(valid, true, `schema errors: ${errors.join(';')}`);
});

test('COV: parseSimpleYaml — 4-level indent with subsection + top-level scalar + no-match line', () => {
  // 解析器语义：indent>=4 且有 subsection → 深层路径；indent>=4 无 subsection → section 直挂。
  // 注意：subsection 一旦建立，后续 indent>=4 行都走深层路径（169-170 分支需在 subsection 之前）。
  const yaml = [
    'top: scalar-value',           // indent 0 + value → root scalar（157）
    'section:',                    // indent 0 section
    '    plain: hello',            // indent 4 + section only（169-170，先于 subsection）
    '  sub:',                      // indent 2 subsection（164-165）
    '    deep: 42',                // indent 4 + subsection → deep path
    'this line has no colon',      // kv 不匹配 → continue
    '',                            // 空行
  ].join('\n');
  const parsed = parseSimpleYaml(yaml);
  assert.equal(parsed.top, 'scalar-value');
  assert.equal(parsed.section.plain, 'hello');
  assert.equal(parsed.section.sub.deep, 42);
});

test('COV: loadBands — ASTRA_BANDS_FILE unreadable → defaults', () => {
  process.env.ASTRA_BANDS_FILE = path.join(TEST_STATE, 'nonexistent-bands.yaml');
  try {
    const bands = loadBands();
    assert.deepEqual(bands['loop-guard'], BANDS_DEFAULTS['loop-guard']);
  } finally {
    delete process.env.ASTRA_BANDS_FILE;
  }
});

// ---------- validate.mjs：validateInput 失败分支 ----------
import { validateInput, isSafePath, isExemptTool } from '../src/lib/validate.mjs';

test('COV: validateInput — all rejection branches', () => {
  assert.equal(validateInput(null).valid, false);
  assert.equal(validateInput('string').valid, false);
  // 不可序列化（循环引用）
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(validateInput(cyclic).valid, false);
  // 超过 MAX_INPUT_BYTES
  assert.equal(validateInput({ pad: 'x'.repeat(1_100_000) }).valid, false);
  // sessionId 非字符串
  assert.equal(validateInput({ sessionId: 123 }).valid, false);
  // toolName 非字符串
  assert.equal(validateInput({ toolName: 456 }).valid, false);
  // prompt 超长
  assert.equal(validateInput({ prompt: 'x'.repeat(20_001) }).valid, false);
  // 合法输入
  assert.equal(validateInput({ sessionId: 's', toolName: 't', prompt: 'ok' }).valid, true);
});

test('COV: isSafePath — edge branches', () => {
  assert.equal(isSafePath(''), false);
  assert.equal(isSafePath(123), false);
  assert.equal(isSafePath('a\\..\\b'), false, 'backslash normalized then traversal rejected');
  assert.equal(isSafePath('a\0b'), false, 'NUL byte rejected');
  assert.equal(isSafePath('a..b/c'), true, 'segment a..b is valid');
});

test('COV: isExemptTool — null tool / non-array list', () => {
  assert.equal(isExemptTool(null, ['read_file']), false);
  assert.equal(isExemptTool('read_file', 'not-array'), false);
  assert.equal(isExemptTool('read_file', ['read_file']), true);
});

// ---------- state.mjs：withLock 锁竞争与超时路径 ----------
import { updateState, readState, stateRoot } from '../src/lib/state.mjs';

test('COV: stateRoot dynamic env read (#957 refactor)', () => {
  assert.equal(stateRoot(), path.resolve(TEST_STATE));
});

test('COV: updateState — mutate returns null → no write', async () => {
  const s = 'cov-null-mutate';
  await updateState('loop-guard', s, () => ({ a: 1 }));
  const r = await updateState('loop-guard', s, () => null);
  assert.deepEqual(r, { a: 1 });
});

test('COV: updateState — lock contention path (EEXIST then acquire)', async () => {
  const s = 'cov-lock-contention';
  // 预先创建锁文件 → 第一次 openSync('wx') 抛 EEXIST → retry 循环 → 持有者释放后获取
  const file = path.join(TEST_STATE, 'loop-guard', `${s}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lockPath = `${file}.lock`;
  fs.writeFileSync(lockPath, '', 'utf8');
  // 50ms 后释放锁（模拟并发持有者）
  setTimeout(() => fs.rmSync(lockPath, { force: true }), 50);
  const result = await updateState('loop-guard', s, () => ({ v: 1 }));
  assert.deepEqual(result, { v: 1 });
});

test('COV: updateState — lock timeout → fail-open execute without lock', async () => {
  const s = 'cov-lock-timeout';
  const file = path.join(TEST_STATE, 'loop-guard', `${s}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lockPath = `${file}.lock`;
  fs.writeFileSync(lockPath, '', 'utf8');
  // 不释放锁 → 300ms 超时 → fail-open 直接执行（不删他人锁）
  const result = await updateState('loop-guard', s, () => ({ v: 2 }));
  assert.deepEqual(result, { v: 2 });
  assert.equal(fs.existsSync(lockPath), true, 'timeout path must NOT delete foreign lock');
  fs.rmSync(lockPath, { force: true });
});

test('COV: readState — corrupt JSON → null', async () => {
  const s = 'cov-corrupt';
  const file = path.join(TEST_STATE, 'loop-guard', `${s}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not-json', 'utf8');
  assert.equal(await readState('loop-guard', s), null);
});

// ---------- runtime.mjs：summarizeInput debug + 未知 hook + 异常 fail-open ----------
const BIN = path.join(ROOT, 'bin', 'astra-hook.mjs');

function callBin(hookName, stdin, extraEnv = {}) {
  return spawnSync(process.execPath, [BIN, hookName, '--debug'], {
    input: stdin,
    env: { ...process.env, ASTRA_HOOK_STATE_DIR: TEST_STATE, ...extraEnv },
    timeout: 15000,
    encoding: 'utf8',
  });
}

test('COV: runtime — unknown hook → fail-open allow (debug path)', () => {
  const res = callBin('no-such-hook', JSON.stringify({ sessionId: 'x', hookEventName: 'PreToolUse' }));
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
});

test('COV: runtime — invalid input validation → fail-open (debug path)', () => {
  const res = callBin('loop-guard', JSON.stringify({ sessionId: 123, hookEventName: 'PreToolUse' }));
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
});

test('COV: runtime — event mismatch → allow skip (debug path)', () => {
  const res = callBin('loop-guard', JSON.stringify({ sessionId: 'x', hookEventName: 'Stop' }));
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /event not applicable/);
});

test('COV: runtime — debug summarizeInput covers object/sensitive/long-string fields', () => {
  // summarizeInput 语义：对象值整体走 {keys,length} 路径（不逐键脱敏）；
  // 顶层敏感键（apiKey）→ [REDACTED]；超长字符串 → 截断。分别构造三种顶层字段。
  const bigInput = JSON.stringify({
    sessionId: 'x',
    hookEventName: 'PreToolUse',
    apiKey: 'sk-secret-123',                    // 顶层敏感键 → [REDACTED]
    longString: 'y'.repeat(300),                // 超长字符串 → 截断
    toolInput: { a: 1, b: 2 },                  // 对象 → {keys,length}
    toolName: 't',
  });
  const res = callBin('loop-guard', bigInput);
  assert.equal(res.status, 0);
  // debug stderr 应包含脱敏后的 input 摘要（summarizeInput 22-38 全分支）
  assert.match(res.stderr, /\[astra-hook\] input:/);
  assert.match(res.stderr, /\[REDACTED\]/);
  assert.match(res.stderr, /keys/);
});

test('COV: runtime — hook module throwing → fail-open (catch path 103-108)', () => {
  // 触发方式：stdin 含 NUL 字节的合法 JSON → normalizeInput 后 validateInput
  // 的 JSON.stringify 抛错？否——用更直接的方式：stdin 为合法 JSON 但
  // runtime 动态 import 失败（hook 名合法但模块加载抛错不可构造）。
  // 实际可达路径：delivery-gate 的 readdirSync 抛错需要 artifactDir 存在但
  // readdir 失败——用文件冒充目录：existsSync(file)=true 但 readdirSync 抛 ENOTDIR。
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-ws2-'));
  // 用文件占据 specs 目录位置 → existsSync true，readdirSync 抛 ENOTDIR → catch → fail-open
  const specDir = path.join(wsRoot, 'docs/03-agile/artifacts/specs');
  fs.mkdirSync(path.dirname(specDir), { recursive: true });
  fs.writeFileSync(specDir, 'i-am-a-file', 'utf8');
  const res = spawnSync(process.execPath, [BIN, 'delivery-gate'], {
    input: JSON.stringify({ sessionId: 'x', hookEventName: 'PreToolUse', toolName: 'create_file' }),
    env: {
      ...process.env,
      ASTRA_HOOK_STATE_DIR: TEST_STATE,
      ASTRA_SDLC_PHASE: 'design',
      ASTRA_WORKSPACE_ROOT: wsRoot,
    },
    timeout: 15000,
    encoding: 'utf8',
  });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  // readdirSync 抛 ENOTDIR → catch → fail-open allow（delivery-gate catch 分支 76-78）
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /fail-open/);
});

// ---------- decision-log.mjs：分支补齐（gh 对假 Issue 无副作用，已验证 exit 1） ----------
test('COV: decision-log — branch-resolve path + negative keyword + empty prompt', async () => {
  const { run } = await import('../src/runtime.mjs');

  // 空 prompt → no prompt 分支
  const r0 = await run('decision-log', JSON.stringify({ hookEventName: 'UserPromptSubmit' }), {});
  assert.match(r0.hookSpecificOutput.permissionDecisionReason, /no prompt/);

  // 反向关键词 + 无 Issue 编号 → scheduled branch-resolve 分支（后台 git 解析）
  const r1 = await run('decision-log', JSON.stringify({
    prompt: '这个方案需要修改，暂缓',
    hookEventName: 'UserPromptSubmit',
  }), {});
  assert.match(r1.hookSpecificOutput.permissionDecisionReason, /branch-resolve/);
  await new Promise((res) => setImmediate(res));

  // issue N 格式（非 #N）→ extractIssueNumberSync 第二正则
  const r2 = await run('decision-log', JSON.stringify({
    prompt: 'Approved issue 9999 确认合并',
    hookEventName: 'UserPromptSubmit',
  }), {});
  assert.match(r2.hookSpecificOutput.permissionDecisionReason, /scheduled comment/);
  await new Promise((res) => setImmediate(res));
});

test('COV: decision-log — sanitizePrompt branches via postComment (gh fails silently on fake issue)', async () => {
  const { run } = await import('../src/runtime.mjs');
  // 触发 postComment：prompt 含 @提人/URL/敏感键值/控制字符/超长 → sanitizePrompt 全分支
  const longPrompt = `Approved #9999 @someone https://evil.example.com apiKey=sk-123 \u0007 ${'z'.repeat(600)}`;
  const r = await run('decision-log', JSON.stringify({
    prompt: longPrompt,
    hookEventName: 'UserPromptSubmit',
  }), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
  // 等待 setImmediate + execFile 回调（gh 对 9999 失败 exit 1，静默 fail-open）
  await new Promise((res) => setTimeout(res, 300));
});

// ---------- session-issue-link.mjs：分支补齐 ----------
import sessionIssueLink from '../src/hooks/session-issue-link.mjs';

test('COV: session-issue-link — all branches', async () => {
  const linkFile = path.join(TEST_STATE, 'issue-link.md');

  // no event
  const r0 = await sessionIssueLink({}, {}, {});
  assert.match(r0.hookSpecificOutput.permissionDecisionReason, /no event/);

  // event not applicable
  const r1 = await sessionIssueLink({ hookEventName: 'Stop' }, {}, {});
  assert.match(r1.hookSpecificOutput.permissionDecisionReason, /not applicable/);

  // PostToolUse 非 issue_write
  const r2 = await sessionIssueLink({ hookEventName: 'PostToolUse', toolName: 'read_file' }, {}, {});
  assert.match(r2.hookSpecificOutput.permissionDecisionReason, /not issue_write/);

  // PostToolUse issue_write 无 response
  const r3 = await sessionIssueLink({ hookEventName: 'PostToolUse', toolName: 'issue_write', toolResponse: '' }, {}, {});
  assert.match(r3.hookSpecificOutput.permissionDecisionReason, /no issue number/);

  // unsafe path（meta.linkFile 含穿越）
  const r4 = await sessionIssueLink(
    { hookEventName: 'PostToolUse', toolName: 'issue_write', toolResponse: '{"id":"123"}' },
    { linkFile: '../evil.md' },
    {},
  );
  assert.match(r4.hookSpecificOutput.permissionDecisionReason, /unsafe link path/);

  // 正常写入（"id":"N" 提取）+ SessionStart 分支名解析（当前分支 feature/...-957 → 957）
  const r5 = await sessionIssueLink(
    { hookEventName: 'PostToolUse', toolName: 'IssueWrite', toolResponse: 'created {"id": "4242"} ok' },
    { linkFile },
    { debug: true },
  );
  assert.match(r5.hookSpecificOutput.permissionDecisionReason, /recorded/);
  const content = fs.readFileSync(linkFile, 'utf8');
  assert.match(content, /issue=#4242/);
  assert.match(content, /session=/, 'sessionId sanitized line present');

  // SessionStart（分支名含数字 → issueNum）
  const r6 = await sessionIssueLink({ hookEventName: 'SessionStart', sessionId: 's\nx' }, { linkFile }, {});
  assert.equal(r6.hookSpecificOutput.permissionDecision, 'allow');

  // #N 提取路径（extractFromResponse 第二正则）
  const r7 = await sessionIssueLink(
    { hookEventName: 'PostToolUse', toolName: 'create_issue', toolResponse: 'see #777' },
    { linkFile },
    {},
  );
  assert.match(r7.hookSpecificOutput.permissionDecisionReason, /recorded/);
  const content2 = fs.readFileSync(linkFile, 'utf8');
  assert.match(content2, /issue=#777/);
});

test('COV: session-issue-link — write failure fail-open (debug path)', async () => {
  // linkFile 指向一个文件路径的子路径 → mkdirSync/appendFileSync 抛错
  const blocker = path.join(TEST_STATE, 'blocker-file');
  fs.writeFileSync(blocker, 'x', 'utf8');
  const r = await sessionIssueLink(
    { hookEventName: 'PostToolUse', toolName: 'issue_write', toolResponse: '{"id":"1"}' },
    { linkFile: path.join(blocker, 'sub', 'link.md') },
    { debug: true },
  );
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /write failed/);
});

// ---------- delivery-gate.mjs：76-78（exists 分支已覆盖，补 unknown phase/debug） ----------
test('COV: delivery-gate — unknown phase + artifact present + debug', async () => {
  const { run } = await import('../src/runtime.mjs');
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-ws-'));
  process.env.ASTRA_WORKSPACE_ROOT = wsRoot;
  try {
    // unknown phase
    let res = callBin('delivery-gate', JSON.stringify({ sessionId: 'x', hookEventName: 'PreToolUse', toolName: 'create_file' }), { ASTRA_SDLC_PHASE: 'unknown-phase' });
    let out = JSON.parse(res.stdout);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /unknown phase/);

    // design + spec.md 存在 → allow（76-78 exists=true 分支）
    const specDir = path.join(wsRoot, 'docs/03-agile/artifacts/specs');
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, 'spec-001-test.md'), 'x', 'utf8');
    res = callBin('delivery-gate', JSON.stringify({ sessionId: 'x', hookEventName: 'PreToolUse', toolName: 'create_file' }), { ASTRA_SDLC_PHASE: 'design' });
    out = JSON.parse(res.stdout);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /present/);
  } finally {
    delete process.env.ASTRA_WORKSPACE_ROOT;
  }
});
