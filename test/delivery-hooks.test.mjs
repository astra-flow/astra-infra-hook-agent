/**
 * delivery-hooks.test.mjs — 交付门禁 hooks evals（#976：2 硬 3 软）
 *
 * 覆盖（5 hooks × 关键路径）：
 *   delivery-branch-guard（阻断）：
 *     1. implement 阶段 + main 分支 → deny
 *     2. implement 阶段 + feature 分支 → allow
 *     3. implement 阶段 + hotfix 分支 → allow
 *     4. 未声明阶段 → allow（fail-open）
 *     5. 读工具 → allow
 *   delivery-test-gate（阻断）：
 *     6. converge 阶段 + test.md 缺失 → deny
 *     7. converge 阶段 + test.md 含执行记录 → allow
 *     8. 未声明阶段 → allow
 *   delivery-constitution-check（警告）：
 *     9. plan 阶段 + plan.md 缺 Constitution Check 节 → allow + additionalContext 警告
 *    10. plan 阶段 + plan.md 含节 → allow 无警告
 *   delivery-workitem-link（警告）：
 *    11. specify 阶段 + spec.md 缺 work-item ID → allow + 警告
 *    12. specify 阶段 + spec.md 含 ID → allow 无警告
 *   delivery-stage-label（警告）：
 *    13. 标签与阶段不符 → allow + 警告
 *    14. 标签一致 → allow 无警告
 *    15. 未声明标签 → allow（fail-open）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/runtime.mjs';

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-delivery-'));
process.env.ASTRA_WORKSPACE_ROOT = TEST_ROOT;

const SESSION = 'delivery-hooks-test-session';

const writeTool = (toolName = 'create_file') => JSON.stringify({
  sessionId: SESSION,
  toolName,
  toolInput: { filePath: '/tmp/x.ts', content: 'code' },
  hookEventName: 'PreToolUse',
});

const postTool = (toolName = 'create_file') => JSON.stringify({
  sessionId: SESSION,
  toolName,
  toolInput: { filePath: '/tmp/x.ts', content: 'code' },
  hookEventName: 'PostToolUse',
});

/** 在 specs/ 下创建 feature 目录与 artifact */
function setupSpec(artifacts = {}) {
  const dir = path.join(TEST_ROOT, 'specs', '001-test-feature');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(artifacts)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

// ---- delivery-branch-guard（阻断）----

test('BRANCH: implement phase + main branch → deny', async () => {
  process.env.ASTRA_SDLC_PHASE = 'implement';
  process.env.ASTRA_GIT_BRANCH = 'main';
  const r = await run('delivery-branch-guard', writeTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /分支/);
  assert.ok(r.systemMessage, 'deny must include systemMessage');
  delete process.env.ASTRA_GIT_BRANCH;
});

test('BRANCH: implement phase + feature branch → allow', async () => {
  process.env.ASTRA_SDLC_PHASE = 'implement';
  process.env.ASTRA_GIT_BRANCH = 'feature/test-976';
  const r = await run('delivery-branch-guard', writeTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
  delete process.env.ASTRA_GIT_BRANCH;
});

test('BRANCH: implement phase + hotfix branch → allow', async () => {
  process.env.ASTRA_SDLC_PHASE = 'implement';
  process.env.ASTRA_GIT_BRANCH = 'hotfix/urgent-976';
  const r = await run('delivery-branch-guard', writeTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
  delete process.env.ASTRA_GIT_BRANCH;
});

test('BRANCH: implement phase + fix branch → allow (#1004 bugfix scenario)', async () => {
  process.env.ASTRA_SDLC_PHASE = 'implement';
  process.env.ASTRA_GIT_BRANCH = 'fix/null-pointer-1004';
  const r = await run('delivery-branch-guard', writeTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
  delete process.env.ASTRA_GIT_BRANCH;
});

test('BRANCH: implement phase + refactor branch → allow (#1004 refactor scenario)', async () => {
  process.env.ASTRA_SDLC_PHASE = 'implement';
  process.env.ASTRA_GIT_BRANCH = 'refactor/extract-service-1004';
  const r = await run('delivery-branch-guard', writeTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
  delete process.env.ASTRA_GIT_BRANCH;
});

test('BRANCH: no phase declared → allow (fail-open)', async () => {
  delete process.env.ASTRA_SDLC_PHASE;
  const r = await run('delivery-branch-guard', writeTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
});

test('BRANCH: read tool → allow', async () => {
  process.env.ASTRA_SDLC_PHASE = 'implement';
  const r = await run('delivery-branch-guard', writeTool('read_file'), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
});

// ---- delivery-test-gate（阻断）----

test('TESTGATE: converge phase + test.md missing → deny', async () => {
  process.env.ASTRA_SDLC_PHASE = 'converge';
  setupSpec({ 'spec.md': '# spec' });
  const r = await run('delivery-test-gate', writeTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /test\.md/);
});

test('TESTGATE: converge phase + test.md with evidence → allow', async () => {
  process.env.ASTRA_SDLC_PHASE = 'converge';
  setupSpec({
    'spec.md': '# spec',
    'test.md': '# 测试\n## 执行记录\n全部通过',
  });
  const r = await run('delivery-test-gate', writeTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
});

test('TESTGATE: converge phase + test.md without evidence section → deny', async () => {
  process.env.ASTRA_SDLC_PHASE = 'converge';
  setupSpec({
    'spec.md': '# spec',
    'test.md': '# 测试\n（无执行记录节）',
  });
  const r = await run('delivery-test-gate', writeTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /执行记录节/);
});

test('TESTGATE: no phase declared → allow', async () => {
  delete process.env.ASTRA_SDLC_PHASE;
  const r = await run('delivery-test-gate', writeTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
});

// ---- delivery-constitution-check（警告）----

test('CONSTITUTION: plan phase + plan.md missing section → allow + warn', async () => {
  process.env.ASTRA_SDLC_PHASE = 'plan';
  setupSpec({
    'spec.md': '# spec',
    // 注意：负例文本不能包含 "Constitution Check" 字样（includes 判定）
    'plan.md': '# plan\n## 架构\n## 数据模型\n## 项目结构',
  });
  const r = await run('delivery-constitution-check', postTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
  assert.match(r.hookSpecificOutput.additionalContext, /Constitution Check/);
  assert.ok(r.systemMessage);
});

test('CONSTITUTION: plan phase + plan.md with section → allow no warn', async () => {
  process.env.ASTRA_SDLC_PHASE = 'plan';
  setupSpec({
    'spec.md': '# spec',
    'plan.md': '# plan\n## Constitution Check\n- [x] 全部通过',
  });
  const r = await run('delivery-constitution-check', postTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(r.hookSpecificOutput.additionalContext, undefined);
});

test('CONSTITUTION: no phase declared → allow', async () => {
  delete process.env.ASTRA_SDLC_PHASE;
  const r = await run('delivery-constitution-check', postTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
});

// ---- delivery-workitem-link（警告）----

test('WORKITEM: specify phase + spec.md missing ID → allow + warn', async () => {
  process.env.ASTRA_SDLC_PHASE = 'specify';
  setupSpec({ 'spec.md': '# spec\n## User Stories\n...' });
  const r = await run('delivery-workitem-link', postTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
  assert.match(r.hookSpecificOutput.additionalContext, /work-item/);
});

test('WORKITEM: specify phase + spec.md with ID → allow no warn', async () => {
  process.env.ASTRA_SDLC_PHASE = 'specify';
  setupSpec({ 'spec.md': '# spec\nwork-item: #976\n## User Stories' });
  const r = await run('delivery-workitem-link', postTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(r.hookSpecificOutput.additionalContext, undefined);
});

// ---- delivery-stage-label（警告）----

test('STAGELABEL: label mismatch → allow + warn', async () => {
  process.env.ASTRA_SDLC_PHASE = 'implement';
  process.env.ASTRA_STAGE_LABEL = 'stage:specify';
  const r = await run('delivery-stage-label', postTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
  assert.match(r.hookSpecificOutput.additionalContext, /不一致/);
  delete process.env.ASTRA_STAGE_LABEL;
});

test('STAGELABEL: label match → allow no warn', async () => {
  process.env.ASTRA_SDLC_PHASE = 'implement';
  process.env.ASTRA_STAGE_LABEL = 'stage:feature';
  const r = await run('delivery-stage-label', postTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(r.hookSpecificOutput.additionalContext, undefined);
  delete process.env.ASTRA_STAGE_LABEL;
});

test('STAGELABEL: no label declared → allow (fail-open)', async () => {
  process.env.ASTRA_SDLC_PHASE = 'implement';
  delete process.env.ASTRA_STAGE_LABEL;
  const r = await run('delivery-stage-label', postTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
});

// ---- 清理 ----

test('CLEANUP: remove phase env', async () => {
  delete process.env.ASTRA_SDLC_PHASE;
  assert.ok(true);
});

// ---- 覆盖率补齐（#957 规范：新增代码 100%）----

test('COV: branch-guard — git unavailable fail-open path (42-50)', async () => {
  process.env.ASTRA_SDLC_PHASE = 'implement';
  // ASTRA_GIT_BRANCH 未设置 + git 在非 repo 目录失败 → catch → fail-open allow
  delete process.env.ASTRA_GIT_BRANCH;
  const r = await run('delivery-branch-guard', writeTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /fail-open|ok/);
});

test('COV: constitution-check — specs dir readdir fail-open (22-23/29-30/33-34) + unknown phase (61-63)', async () => {
  // unknown phase → allow（61-63）
  process.env.ASTRA_SDLC_PHASE = 'unknown-phase';
  let r = await run('delivery-constitution-check', postTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
  // specs/ 为文件 → readdirSync 抛 ENOTDIR → catch → fail-open（29-30/33-34）
  const badRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-cc-bad-'));
  fs.writeFileSync(path.join(badRoot, 'specs'), 'file-not-dir', 'utf8');
  process.env.ASTRA_SDLC_PHASE = 'plan';
  process.env.ASTRA_WORKSPACE_ROOT = badRoot;
  r = await run('delivery-constitution-check', postTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
  process.env.ASTRA_WORKSPACE_ROOT = TEST_ROOT;
});

test('COV: test-gate — specs 为文件 fail-open (36-37/43-44) + 无 feature 目录 (65-66) + 空目录 (79-81)', async () => {
  // specs/ 为文件 → readdirSync 抛错 → fail-open
  const badRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-tg-bad-'));
  fs.writeFileSync(path.join(badRoot, 'specs'), 'file-not-dir', 'utf8');
  process.env.ASTRA_SDLC_PHASE = 'converge';
  process.env.ASTRA_WORKSPACE_ROOT = badRoot;
  let r = await run('delivery-test-gate', writeTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
  // specs/ 存在但无 feature 目录 → deny reason "无 feature 目录"（65-66）
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-tg-empty-'));
  fs.mkdirSync(path.join(emptyRoot, 'specs'), { recursive: true });
  process.env.ASTRA_WORKSPACE_ROOT = emptyRoot;
  r = await run('delivery-test-gate', writeTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /feature 目录/);
  process.env.ASTRA_WORKSPACE_ROOT = TEST_ROOT;
});

test('COV: workitem-link — specs 异常 fail-open (26-27/33-34/37-38) + plan/spec 缺失跳过 (58-59/66-68)', async () => {
  // specs/ 为文件 → fail-open
  const badRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-wl-bad-'));
  fs.writeFileSync(path.join(badRoot, 'specs'), 'file-not-dir', 'utf8');
  process.env.ASTRA_SDLC_PHASE = 'specify';
  process.env.ASTRA_WORKSPACE_ROOT = badRoot;
  let r = await run('delivery-workitem-link', postTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
  // specs/ 空目录 → 跳过（33-34/37-38）
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-wl-empty-'));
  fs.mkdirSync(path.join(emptyRoot, 'specs'), { recursive: true });
  process.env.ASTRA_WORKSPACE_ROOT = emptyRoot;
  r = await run('delivery-workitem-link', postTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
  // feature 目录存在但 spec.md 未产出 → 跳过（58-59/66-68）
  const noSpecRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-wl-nospec-'));
  fs.mkdirSync(path.join(noSpecRoot, 'specs/002-x'), { recursive: true });
  process.env.ASTRA_WORKSPACE_ROOT = noSpecRoot;
  r = await run('delivery-workitem-link', postTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
  process.env.ASTRA_WORKSPACE_ROOT = TEST_ROOT;
});

test('COV: stage-label — no phase (33-34) + unknown phase (44-45)', async () => {
  // 无 phase → allow（33-34）
  delete process.env.ASTRA_SDLC_PHASE;
  process.env.ASTRA_STAGE_LABEL = 'stage:feature';
  let r = await run('delivery-stage-label', postTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
  // unknown phase → allow（44-45）
  process.env.ASTRA_SDLC_PHASE = 'unknown-phase';
  r = await run('delivery-stage-label', postTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
  delete process.env.ASTRA_STAGE_LABEL;
});

test('COV2: constitution/test-gate/workitem-link — specs/ 不存在分支', async () => {
  const noSpecsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-cov2-'));
  process.env.ASTRA_WORKSPACE_ROOT = noSpecsRoot;
  // constitution-check：specs/ 不存在 → 跳过（22-23）
  process.env.ASTRA_SDLC_PHASE = 'plan';
  let r = await run('delivery-constitution-check', postTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
  // test-gate：specs/ 不存在 → deny "specs/ 目录不存在"（36-37）
  process.env.ASTRA_SDLC_PHASE = 'converge';
  r = await run('delivery-test-gate', writeTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /specs\/ 目录不存在/);
  // workitem-link：specs/ 不存在 → 跳过（26-27）
  process.env.ASTRA_SDLC_PHASE = 'specify';
  r = await run('delivery-workitem-link', postTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
  process.env.ASTRA_WORKSPACE_ROOT = TEST_ROOT;
});

test('COV3: 空 specs 目录 + plan.md 未产出 + 非 specify 阶段分支', async () => {
  // constitution-check：specs/ 空目录 → "无 feature 目录"（29-30）
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-cov3-'));
  fs.mkdirSync(path.join(emptyRoot, 'specs'), { recursive: true });
  process.env.ASTRA_WORKSPACE_ROOT = emptyRoot;
  process.env.ASTRA_SDLC_PHASE = 'plan';
  let r = await run('delivery-constitution-check', postTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
  // constitution-check：feature 目录存在但 plan.md 未产出（33-34）
  fs.mkdirSync(path.join(emptyRoot, 'specs/003-y'), { recursive: true });
  r = await run('delivery-constitution-check', postTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
  // test-gate：非 converge 阶段（65-66 = WRITE_TOOLS 早退已在其他用例覆盖；此处为 converge 下 dirs[0] 无 test.md 的 deny 已覆盖）
  // workitem-link：非 specify 阶段（58-59）
  process.env.ASTRA_SDLC_PHASE = 'plan';
  r = await run('delivery-workitem-link', postTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
  process.env.ASTRA_WORKSPACE_ROOT = TEST_ROOT;
});

test('COV4: test-gate — 读工具早退（65-66）', async () => {
  process.env.ASTRA_SDLC_PHASE = 'converge';
  const r = await run('delivery-test-gate', writeTool('read_file'), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
});
