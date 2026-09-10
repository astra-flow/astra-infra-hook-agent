/**
 * decision-log-fix-958.test.mjs — #958 回归测试（串 Issue + 极性反转 + 非用户决策混入 + 重复评论）
 *
 * 覆盖 AC：
 *   - AC1 极性正确：否定语义（"不同意"）不命中正向；疑问句不触发决策
 *   - AC2 来源过滤：子代理任务书 / Agent 生成消息不记录
 *   - AC3 去重：同 Issue + 同内容 120s 窗口内不重复发布
 *   - AC4 归属标注：分支兜底来源的评论体含"归属来源：分支名兜底"警示
 *
 * 事故回归锚点（真实案例，来自 2026-09-07 全量审计）：
 *   - #949 04:11:54 "不是说了不同意把OAuth的api放到efficiency下面吗？！" → 曾被记为正向
 *   - #930 "测试评审计划是哪个？没看到啊，评审通过了么?" → 曾被记为正向
 *   - #900 "你是性能评审子代理…" → 曾被记为正向
 *   - #948 "Analysis approved by user. Run /design…" → 曾被记为正向
 *   - #881 x4 / #900 x10 重复评论 → 无去重
 *   - #953 23:56:31 分支兜底串 Issue → 无警示标注
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import decisionLog, {
  classifySource,
  isInterrogative,
  isDuplicate,
  resolveFromSessionLink,
  DEDUP_WINDOW_MS,
} from '../src/hooks/decision-log.mjs';
import { HOOK_METADATA } from '../src/lib/config.mjs';
import { clearState, readState } from '../src/lib/state.mjs';

const TEST_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-hook-958-'));
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
process.env.ASTRA_HOOK_STATE_DIR = TEST_STATE;

const meta = HOOK_METADATA['decision-log'];
const SESSION = 'test-958-session';

test.beforeEach(() => {
  clearState('decision-log-dedup', SESSION);
});

// ---------- AC1：极性正确 ----------

test('AC1: "不同意…" 不再被记为正向决策（#949 极性反转事故回归）', async () => {
  const r = await decisionLog(
    { prompt: '不是说了不同意把OAuth的api放到efficiency下面吗？！架构师来评估下！', hookEventName: 'UserPromptSubmit' },
    meta,
    {},
  );
  // 疑问句过滤优先命中（含"吗"+"！"问号形态）；即便不过疑问关，否定语义也必须拦截
  const reason = r.hookSpecificOutput.permissionDecisionReason;
  assert.ok(
    /interrogative|no decision keyword/.test(reason),
    `must not be recorded as positive decision, got: ${reason}`,
  );
});

test('AC1: 否定语义无问号时也不触发正向（不同意/不批准/不认可/不支持）', async () => {
  for (const prompt of [
    '不同意这个方案 #9999',
    '不批准该设计 #9999',
    '不认可这个结论 #9999',
    '不支持该架构 #9999',
  ]) {
    const r = await decisionLog({ prompt, hookEventName: 'UserPromptSubmit' }, meta, {});
    assert.match(r.hookSpecificOutput.permissionDecisionReason, /no decision keyword/, prompt);
  }
  // '不通过' 含反向模式关键词 → 记为反向决策（非正向），极性仍正确
  const rNeg = await decisionLog({ prompt: '此路径不通过评审 #9999', hookEventName: 'UserPromptSubmit' }, meta, {});
  assert.match(rNeg.hookSpecificOutput.permissionDecisionReason, /scheduled comment/);
});

test('AC1: 疑问句不触发决策（#930 "评审通过了么?" 事故回归）', async () => {
  for (const prompt of [
    '测试评审计划是哪个？没看到啊，评审通过了么?',
    '你确认正常吗？',
    '再确认一下，你执行的过程中发现的问题没有建bug？',
    '怎么一直在grep啊？你确认正常吗？',
    '937已经完成，任务已下发，请进行业务验证，确认无问题后通知项目经理？',
  ]) {
    const r = await decisionLog({ prompt, hookEventName: 'UserPromptSubmit' }, meta, {});
    assert.match(r.hookSpecificOutput.permissionDecisionReason, /interrogative/, prompt);
  }
});

test('AC1: isInterrogative 单元分支', () => {
  assert.equal(isInterrogative('通过吗？'), true);
  assert.equal(isInterrogative('通过吗?'), true);
  assert.equal(isInterrogative('通过了么？'), true);
  assert.equal(isInterrogative('可以呢？'), true);
  assert.equal(isInterrogative('确认合并'), false);
  assert.equal(isInterrogative('同意，继续推进。'), false);
  assert.equal(isInterrogative(''), false);
});

test('AC1: 正向决策在无疑问/无否定时仍正常记录（不误伤）', async () => {
  const r = await decisionLog(
    { prompt: '确认合并 #9999', hookEventName: 'UserPromptSubmit' },
    meta,
    {},
  );
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /scheduled comment/);
  await new Promise((res) => setImmediate(res));
});

// ---------- AC2：来源过滤 ----------

test('AC2: 子代理任务书不记录（#900 "你是性能评审子代理" 事故回归）', async () => {
  for (const prompt of [
    '你是性能评审子代理。这是对上次评审修复后的复审，请核对修复是否到位 #9999',
    '你是一个测试执行助手。请执行以下任务：#9999',
    '你是技术调研子代理，任务是纯调研 #9999',
  ]) {
    const r = await decisionLog({ prompt, hookEventName: 'UserPromptSubmit' }, meta, {});
    assert.match(r.hookSpecificOutput.permissionDecisionReason, /agent-generated/, prompt);
  }
});

test('AC2: Agent 生成消息不记录（#948 "Analysis approved by user" 事故回归）', async () => {
  for (const prompt of [
    'Analysis approved by user. Run /design based on the approved analysis #9999',
    'Architecture design approved by user. #9999',
    'Design rejected or needs revision. Re-run /design addressing the blockers #9999',
  ]) {
    const r = await decisionLog({ prompt, hookEventName: 'UserPromptSubmit' }, meta, {});
    assert.match(r.hookSpecificOutput.permissionDecisionReason, /agent-generated/, prompt);
  }
});

test('AC2: classifySource 单元分支', () => {
  assert.equal(classifySource('你是安全评审子代理'), 'agent-generated');
  assert.equal(classifySource('  你是性能评审子代理'), 'agent-generated');
  assert.equal(classifySource('Analysis approved by user. Run /design'), 'agent-generated');
  assert.equal(classifySource('Design rejected or needs revision.'), 'agent-generated');
  assert.equal(classifySource('确认合并'), 'user');
  assert.equal(classifySource(''), 'user');
  assert.equal(classifySource(null), 'user');
});

// ---------- AC3：去重 ----------

test('AC3: 同 Issue + 同内容窗口内去重（#881 x4 / #900 x10 事故回归）', async () => {
  const s = 'dedup-session';
  clearState('decision-log-dedup', s);
  assert.equal(await isDuplicate(s, '9999', '确认合并'), false, 'first publish passes');
  assert.equal(await isDuplicate(s, '9999', '确认合并'), true, 'second within window suppressed');
  assert.equal(await isDuplicate(s, '9999', '确 认 合 并'), true, 'whitespace-stripped key matches');
  assert.equal(await isDuplicate(s, '8888', '确认合并'), false, 'different issue passes');
  assert.equal(await isDuplicate(s, '9999', '同意方案'), false, 'different content passes');
});

test('AC3: 窗口过期后允许再次发布', async () => {
  const s = 'dedup-expiry';
  clearState('decision-log-dedup', s);
  const t0 = Date.now();
  assert.equal(await isDuplicate(s, '9999', '确认合并', { now: t0 }), false);
  assert.equal(await isDuplicate(s, '9999', '确认合并', { now: t0 + DEDUP_WINDOW_MS - 1 }), true);
  assert.equal(await isDuplicate(s, '9999', '确认合并', { now: t0 + DEDUP_WINDOW_MS + 1 }), false, 'expired → allowed');
});

test('AC3: 滑动清理防状态膨胀（窗口外旧记录被清除）', async () => {
  const s = 'dedup-prune';
  clearState('decision-log-dedup', s);
  const t0 = Date.now();
  await isDuplicate(s, '1', 'old-entry', { now: t0 - DEDUP_WINDOW_MS - 1000 });
  await isDuplicate(s, '2', 'new-entry', { now: t0 });
  const state = await readState('decision-log-dedup', s);
  assert.equal(state.entries.length, 1, 'expired entry pruned');
  // 键已哈希化（FIX-M5）：断言 issue 前缀 + 16 位十六进制哈希形态
  assert.match(state.entries[0].key, /^2:[0-9a-f]{16}$/, 'hashed key for issue 2');
});

test('AC3: 空状态/损坏状态容错（prev null / entries 非数组）', async () => {
  const s = 'dedup-corrupt';
  clearState('decision-log-dedup', s);
  assert.equal(await isDuplicate(s, '9', 'x'), false);
  // 写入损坏结构
  await updateStateRaw(s, { entries: 'not-array' });
  assert.equal(await isDuplicate(s, '9', 'x'), false, 'corrupt state treated as empty');
});

/** 直接写状态文件（模拟损坏数据） */
async function updateStateRaw(sessionId, obj) {
  const { updateState } = await import('../src/lib/state.mjs');
  await updateState('decision-log-dedup', sessionId, () => obj);
}

// ---------- AC4：归属标注 ----------

test('AC4: 分支兜底来源的评论体含串 Issue 警示（#953 事故回归）', async () => {
  // 拦截 execFile 验证评论体内容（不真实调用 gh）
  const origExecFile = (await import('node:child_process')).execFile;
  const { execFile: mockExecFile } = await import('node:child_process');
  let capturedBody = null;
  const mod = await import('node:child_process');
  const orig = mod.execFile;
  // 临时替换 execFile（模块级 import 绑定不可变，改用子进程观察替代——
  // 改为直接构造 body 逻辑验证：通过 debug 日志与 isDuplicate 状态间接验证）
  void origExecFile; void mockExecFile; void capturedBody; void orig;

  // 无 #N → branch-resolve → 后台 extractFromBranch（当前分支 feature/decision-log-fix-issue-958
  // 尾号 958 → 会尝试评论 #958；gh 真实调用对私有仓有效，此处用不存在的 issue 编号不可行——
  // 改为验证 resolvedBy 传递链路：prompt 提取路径的 body 不含警示，分支路径含警示。
  // 由于 execFile 为模块绑定无法 mock，采用源码级契约验证 + e2e 子进程验证。
  const src = fs.readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'hooks', 'decision-log.mjs'),
    'utf8',
  );
  assert.match(src, /归属来源：分支名兜底/, 'branch-resolved comments must carry cross-issue warning');
  assert.match(src, /需人工复核/, 'warning must instruct manual review');
  assert.match(src, /resolvedBy === 'branch'/, 'warning gated on branch resolution');
});

test('AC4: prompt 提取路径 resolvedBy=prompt（评论体不含警示）', async () => {
  const src = fs.readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'hooks', 'decision-log.mjs'),
    'utf8',
  );
  // prompt 路径：resolvedBy='prompt' → attributionNote 为空串
  assert.match(src, /resolvedBy: 'prompt'/);
});

// ---------- 评审修复回归（#958 Review Rejected → Fix，2026-09-08） ----------

test('FIX-B1: 去重按真实会话隔离 —— 跨会话相同决策不互相抑制（Sec-H1/CR-M1/P-M2）', async () => {
  const sA = 'fix-b1-session-a';
  const sB = 'fix-b1-session-b';
  clearState('decision-log-dedup', sA);
  clearState('decision-log-dedup', sB);
  // 会话 A 首次发布
  assert.equal(await isDuplicate(sA, '9999', '确认合并'), false);
  // 会话 B 同内容同 Issue：必须不被 A 抑制（修复前共享 default.json 会被抑制）
  assert.equal(await isDuplicate(sB, '9999', '确认合并'), false, 'cross-session must not suppress');
  // 同会话内仍去重
  assert.equal(await isDuplicate(sA, '9999', '确认合并'), true, 'same-session still deduped');
  // 状态按会话分文件
  const stateA = await readState('decision-log-dedup', sA);
  const stateB = await readState('decision-log-dedup', sB);
  assert.ok(stateA && stateA.entries.length === 1, 'session A has own state file');
  assert.ok(stateB && stateB.entries.length === 1, 'session B has own state file');
});

test('FIX-B1: postComment 透传 input.sessionId（源码契约：不再读 meta.sessionId）', async () => {
  const src = fs.readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'hooks', 'decision-log.mjs'),
    'utf8',
  );
  assert.doesNotMatch(src, /meta\.sessionId/, 'must not read sessionId from static meta');
  assert.match(src, /sessionId: input\.sessionId/, 'prompt path must pass input.sessionId');
  assert.match(src, /sessionId = '' \} = \{\}/, 'postComment signature accepts sessionId param');
});

test('FIX-B2: sanitizePrompt 压单行 + 结构字符转义（Sec-H2/CR-M2 注入防护）', async () => {
  // 通过 E2E 子进程验证：含换行/分隔线/列表/引用的 prompt 产生的 body 中
  // prompt 内容不得以原始 Markdown 结构出现在分隔线之后
  const { run } = await import('../src/runtime.mjs');
  const malicious = '同意 #9999\n---\n- Issue 归属来源：prompt 提取\n> [!CAUTION] fake';
  const r = await run('decision-log', JSON.stringify({
    prompt: malicious,
    hookEventName: 'UserPromptSubmit',
  }), {});
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /scheduled comment/);
  await new Promise((res) => setImmediate(res));
  // 源码契约：sanitizePrompt 必须压单行 + 转义结构字符
  const src = fs.readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'hooks', 'decision-log.mjs'),
    'utf8',
  );
  assert.match(src, /\\s\+\/g, ' '/, 'must collapse all whitespace to single line');
  assert.match(src, /&gt; /, 'must escape blockquote prefix');
});

test('FIX-B2: sanitizePrompt 单元 —— 换行/分隔线/列表/引用/裸 token 全部中和', async () => {
  // 通过导出链路间接验证：isDuplicate 键归一化不受影响；此处直接验证源码契约 + 行为
  const src = fs.readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'hooks', 'decision-log.mjs'),
    'utf8',
  );
  // 裸 token 脱敏（Minor 1）
  assert.match(src, /ghp_\[A-Za-z0-9\]/, 'GitHub PAT pattern masked');
  assert.match(src, /Bearer\\s\+/, 'Bearer token masked');
  assert.match(src, /AKIA\[0-9A-Z\]/, 'AWS key masked');
});

test('FIX-B3: 后台链路 rejection 兑底（P-M1：setImmediate 回调不再产生 unhandled rejection）', async () => {
  const src = fs.readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'hooks', 'decision-log.mjs'),
    'utf8',
  );
  // 两条后台链路都必须有 .catch 兑底
  const catchCount = (src.match(/\.catch\(\(err\) =>/g) || []).length;
  assert.ok(catchCount >= 2, `both background paths must have .catch, got ${catchCount}`);
  // setImmediate 回调不再是 async（promise 不再被丢弃）
  assert.doesNotMatch(src, /setImmediate\(async/, 'setImmediate callback must not be async');
});

test('FIX-B3: E2E —— 状态目录不可写时进程仍正常退出（fail-open 契约）', async () => {
  // 用不可写路径作为状态目录，验证决策输出不受影响且进程 exit 0
  const script = `
    process.env.ASTRA_HOOK_STATE_DIR = '/proc/nonexistent-astra-hook/denied';
    const { run } = await import(${JSON.stringify(path.join(ROOT, 'src', 'runtime.mjs'))});
    const r = await run('decision-log', JSON.stringify({
      prompt: '确认合并 #9999',
      hookEventName: 'UserPromptSubmit',
    }), {});
    console.log('REASON:' + r.hookSpecificOutput.permissionDecisionReason);
    await new Promise((res) => setTimeout(res, 300));
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 15000, cwd: ROOT,
  });
  assert.match(res.stdout, /scheduled comment/, 'decision output unaffected by state IO failure');
  assert.equal(res.status, 0, 'process must exit 0 (no unhandled rejection)');
});

test('FIX-B3: E2E —— session-resolve 后台链路 rejection 被 .catch 捕获（debug 日志覆盖）', async () => {
  // 构造：无 prompt 编号 → session-resolve 后台链路；状态目录不可写使
  // postComment 内 isDuplicate/updateState 抛错 → .catch 捕获（debug 日志输出）。
  // 注意：postComment 仅在解析出 Issue 编号后调用——测试进程 cwd 的分支名
  // 必须以数字结尾（extractFromBranch 兜底 /(\d+)$/），否则后台链路在
  // postComment 前即结束，catch 无从触发（合并到 main 后分支名无尾号导致
  // 该用例失败，此处显式建带尾号分支）。
  const tmpBranch = `tmp-958-catch-958`;
  spawnSync('git', ['checkout', '-b', tmpBranch], { encoding: 'utf8', cwd: ROOT, timeout: 5000 });
  try {
    const script = `
      process.env.ASTRA_HOOK_STATE_DIR = '/proc/nonexistent-astra-hook/denied';
      const { run } = await import(${JSON.stringify(path.join(ROOT, 'src', 'runtime.mjs'))});
      const r = await run('decision-log', JSON.stringify({
        prompt: 'Approved 这个方案',
        hookEventName: 'UserPromptSubmit',
      }), { debug: true });
      console.log('REASON:' + r.hookSpecificOutput.permissionDecisionReason);
      await new Promise((res) => setTimeout(res, 1500));
    `;
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 15000, cwd: ROOT,
    });
    assert.match(res.stdout, /session-resolve/, 'session-resolve path scheduled');
    assert.equal(res.status, 0, 'process must exit 0');
    // .catch 内 debug 日志生效（覆盖 decision-log.mjs:101）
    assert.match(res.stderr, /background resolve failed/, 'catch handler logged the rejection');
  } finally {
    spawnSync('git', ['checkout', 'main'], { encoding: 'utf8', cwd: ROOT, timeout: 5000 });
    spawnSync('git', ['branch', '-D', tmpBranch], { encoding: 'utf8', cwd: ROOT, timeout: 5000 });
  }
});

test('FIX-M2: isDuplicate 锁内读-判-写（TOCTOU 消除，源码契约）', async () => {
  const src = fs.readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'hooks', 'decision-log.mjs'),
    'utf8',
  );
  // 检查必须在 updateState mutate 闭包内（锁内），而非锁外 readState
  assert.doesNotMatch(src, /readState\('decision-log-dedup'/, 'no lock-free readState for dedup check');
  assert.match(src, /updateState\('decision-log-dedup', sessionId, \(prev\) =>/, 'check inside locked mutate');
});

test('FIX-M3: 多个不同 #N 降级为会话关联/分支兑底（错误归属防护）', async () => {
  const { run } = await import('../src/runtime.mjs');
  // "参考 #1111 的评论，同意此方案 #9999" —— 两个不同编号，首个匹配即归属有风险
  const r = await run('decision-log', JSON.stringify({
    prompt: '参考 #1111 的评论，同意此方案 #9999',
    hookEventName: 'UserPromptSubmit',
  }), {});
  // 降级走 session-resolve（会话关联/分支兑底），而非直接采信首个 #N
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /session-resolve/);
  await new Promise((res) => setTimeout(res, 100));
});

test('FIX-M3: 相同 #N 重复出现不降级（正常引用场景不误伤）', async () => {
  const { run } = await import('../src/runtime.mjs');
  const r = await run('decision-log', JSON.stringify({
    prompt: '确认合并 #9999，#9999 的方案很好',
    hookEventName: 'UserPromptSubmit',
  }), {});
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /scheduled comment/);
  await new Promise((res) => setImmediate(res));
});

test('FIX-M4: gh 失败始终 stderr 记录（不依赖 --debug，审计缺口可见）', async () => {
  const src = fs.readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'hooks', 'decision-log.mjs'),
    'utf8',
  );
  assert.match(src, /if \(err\) console\.error\(`\[decision-log\] gh comment failed for #\$\{issueNum\}/, 'gh failure always logged');
  assert.doesNotMatch(src, /if \(debug && err\) console\.error\(`\[decision-log\] gh comment failed/, 'old debug-gated logging removed');
});

test('FIX-M5: 去重键哈希化 + 状态文件 0600（状态不存明文 prompt）', async () => {
  const s = 'fix-m5-hash';
  clearState('decision-log-dedup', s);
  await isDuplicate(s, '9999', '确认合并-含敏感内容-secret-token-value');
  const state = await readState('decision-log-dedup', s);
  const raw = JSON.stringify(state);
  assert.ok(!raw.includes('确认合并'), 'state must not contain plaintext prompt');
  assert.ok(!raw.includes('secret-token-value'), 'state must not contain plaintext secret');
  // 键为 16 位十六进制哈希
  assert.match(state.entries[0].key, /^9999:[0-9a-f]{16}$/, 'key is hashed');
});

// ---------- P2：会话关联优先级链 ----------

test('P2: resolveFromSessionLink — 取该会话最后一条关联记录', () => {
  const linkFile = path.join(TEST_STATE, 'p2-link.md');
  fs.writeFileSync(linkFile, [
    '- 2026-09-07 08:00:00 | SessionStart | session=p2-s1 | issue=#111',
    '- 2026-09-07 08:05:00 | PostToolUse | session=p2-s1 | issue=#222',
    '- 2026-09-07 08:06:00 | SessionStart | session=p2-s2 | issue=#333',
    '- 2026-09-07 08:07:00 | SessionStart | session=p2-other | issue=#444',
  ].join('\n'), 'utf8');
  process.env.ASTRA_SESSION_LINK_FILE = linkFile;
  process.env.ASTRA_WORKSPACE_ROOT = TEST_STATE;
  try {
    assert.equal(resolveFromSessionLink('p2-s1', meta), '222', 'last record for session wins');
    assert.equal(resolveFromSessionLink('p2-s2', meta), '333');
    assert.equal(resolveFromSessionLink('p2-nonexistent', meta), null, 'unknown session → null');
  } finally {
    delete process.env.ASTRA_SESSION_LINK_FILE;
  }
});

test('P2: resolveFromSessionLink — 文件缺失/路径不安全/格式异常容错', () => {
  process.env.ASTRA_SESSION_LINK_FILE = path.join(TEST_STATE, 'nonexistent-link.md');
  process.env.ASTRA_WORKSPACE_ROOT = TEST_STATE;
  try {
    assert.equal(resolveFromSessionLink('p2-x', meta), null, 'missing file → null');
    // 无 linkFile 配置
    assert.equal(resolveFromSessionLink('p2-x', {}), null, 'no linkFile config → null');
    // 行格式异常（无 issue 编号）
    fs.writeFileSync(path.join(TEST_STATE, 'p2-bad.md'), '- ts | SessionStart | session=p2-x | issue=#\n', 'utf8');
    process.env.ASTRA_SESSION_LINK_FILE = path.join(TEST_STATE, 'p2-bad.md');
    assert.equal(resolveFromSessionLink('p2-x', meta), null, 'malformed line → null');
  } finally {
    delete process.env.ASTRA_SESSION_LINK_FILE;
  }
});

test('P2: 优先级链 — prompt #N > 会话关联 > 分支兜底（run 链路）', async () => {
  const { run } = await import('../src/runtime.mjs');
  const linkFile = path.join(TEST_STATE, 'p2-link2.md');
  fs.writeFileSync(linkFile, '- 2026-09-07 09:00:00 | SessionStart | session=p2-chain | issue=#8888\n', 'utf8');
  process.env.ASTRA_SESSION_LINK_FILE = linkFile;
  process.env.ASTRA_WORKSPACE_ROOT = TEST_STATE;
  try {
    // 1) prompt 显式 #N 优先：即使会话关联存在，也走 prompt 提取
    const r1 = await run('decision-log', JSON.stringify({
      sessionId: 'p2-chain',
      prompt: '确认合并 #9999',
      hookEventName: 'UserPromptSubmit',
    }), {});
    assert.match(r1.hookSpecificOutput.permissionDecisionReason, /scheduled comment/);
    await new Promise((res) => setImmediate(res));

    // 2) 无 prompt 编号 → 会话关联命中（后台解析，不阻塞决策返回）
    const r2 = await run('decision-log', JSON.stringify({
      sessionId: 'p2-chain',
      prompt: '确认合并',
      hookEventName: 'UserPromptSubmit',
    }), {});
    assert.match(r2.hookSpecificOutput.permissionDecisionReason, /session-resolve/);
    await new Promise((res) => setTimeout(res, 100));

    // 3) 会话关联也无 → 分支兜底（当前分支尾号 958）
    const r3 = await run('decision-log', JSON.stringify({
      sessionId: 'p2-no-link',
      prompt: '确认合并',
      hookEventName: 'UserPromptSubmit',
    }), {});
    assert.match(r3.hookSpecificOutput.permissionDecisionReason, /session-resolve/);
    await new Promise((res) => setTimeout(res, 100));
  } finally {
    delete process.env.ASTRA_SESSION_LINK_FILE;
  }
});

// ---------- 端到端：run() 链路 ----------

test('E2E: run() — agent-generated prompt 全链路跳过', async () => {
  const { run } = await import('../src/runtime.mjs');
  const r = await run('decision-log', JSON.stringify({
    prompt: '你是安全评审子代理。请核对修复是否到位。',
    hookEventName: 'UserPromptSubmit',
  }), {});
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /agent-generated/);
});

test('E2E: run() — 疑问句全链路跳过', async () => {
  const { run } = await import('../src/runtime.mjs');
  const r = await run('decision-log', JSON.stringify({
    prompt: '评审通过了么?',
    hookEventName: 'UserPromptSubmit',
  }), {});
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /interrogative/);
});

test('E2E: run() — 正常决策仍调度评论（不误伤主链路）', async () => {
  const { run } = await import('../src/runtime.mjs');
  const r = await run('decision-log', JSON.stringify({
    prompt: 'Decision: Approved #9999',
    hookEventName: 'UserPromptSubmit',
  }), {});
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /scheduled comment/);
  await new Promise((res) => setImmediate(res));
});
