/**
 * error-class.test.mjs — 错误分类纯函数 + 权限即停链路（#1020 T017）
 *
 * 覆盖：
 *   1. classifyError：403/401 → permission；timeout/5xx → transient；429 → rate-limit（FR-007）
 *   2. 分类失败 fail-open：配置缺失/无匹配/异常 → transient（不误拦）
 *   3. 权限标记链路：PostToolUse 权限错误 → PreToolUse 同类重试直接拦截（FR-008）
 *   4. 瞬时错误重试 1-2 次放行（AC-009）
 *   5. #942 补充实证模拟：GitHub MCP 连续 403 第 1 次即停（AC-013）
 *   6. loadErrorClasses：文件缺失 null / 模式编译 / 缓存
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/runtime.mjs';
import { clearState } from '../src/lib/state.mjs';
import { classifyError, loadErrorClasses, clearErrorClassesCache, ERROR_CLASSES } from '../src/lib/error-class.mjs';

const TEST_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-hook-ec-'));
process.env.ASTRA_HOOK_STATE_DIR = TEST_STATE;

const SESSION = 'error-class-session';

test.beforeEach(() => {
  clearState('loop-guard', SESSION);
  clearErrorClassesCache();
});

// ---------- classifyError 纯函数 ----------

test('EC1: 403/401/Forbidden → permission（FR-007）', () => {
  assert.equal(classifyError('Error: 403 Resource not accessible'), ERROR_CLASSES.PERMISSION);
  assert.equal(classifyError('401 Unauthorized'), ERROR_CLASSES.PERMISSION);
  assert.equal(classifyError({ message: 'Forbidden for this integration' }), ERROR_CLASSES.PERMISSION);
  assert.equal(classifyError('permission denied: write to protected path'), ERROR_CLASSES.PERMISSION);
});

test('EC2: 429/rate limit → rate-limit（需退避，不进重试计数）', () => {
  assert.equal(classifyError('429 Too Many Requests'), ERROR_CLASSES.RATE_LIMIT);
  assert.equal(classifyError('rate limit exceeded, retry after 60s'), ERROR_CLASSES.RATE_LIMIT);
});

test('EC3: timeout/5xx/网络错误 → transient（允许有限重试）', () => {
  assert.equal(classifyError('ETIMEDOUT after 30000ms'), ERROR_CLASSES.TRANSIENT);
  assert.equal(classifyError('502 Bad Gateway'), ERROR_CLASSES.TRANSIENT);
  assert.equal(classifyError('ECONNRESET on socket'), ERROR_CLASSES.TRANSIENT);
  assert.equal(classifyError(''), ERROR_CLASSES.TRANSIENT, '空响应归 transient');
  assert.equal(classifyError(null), ERROR_CLASSES.TRANSIENT);
});

test('EC4: 分类失败 fail-open——无匹配/配置缺失/异常 → transient（不误拦）', () => {
  assert.equal(classifyError('some unrelated output'), ERROR_CLASSES.TRANSIENT, '无匹配归 transient');
  assert.equal(
    classifyError('403 forbidden', { permission: [], transient: [], rateLimit: [] }),
    ERROR_CLASSES.TRANSIENT,
    '空配置归 transient'
  );
  assert.equal(classifyError({ weird: () => {} }), ERROR_CLASSES.TRANSIENT, '不可序列化对象归 transient');
});

test('EC5: loadErrorClasses——文件缺失 null / 正常加载 / 缓存生效', () => {
  assert.equal(loadErrorClasses(path.join(TEST_STATE, 'missing.yaml')), null, '文件缺失 → null');
  // 真实配置文件加载
  const cfg = loadErrorClasses();
  assert.ok(cfg.permission.length > 0, 'permission 模式已编译');
  assert.ok(cfg.transient.length > 0);
  // 缓存：二次调用返回同一引用
  assert.equal(loadErrorClasses(), cfg);
});

// ---------- 权限即停链路（PostToolUse → PreToolUse）----------

const mkPost = (resp) => JSON.stringify({
  sessionId: SESSION,
  toolName: 'mcp_github_mcp_se_push_files',
  toolResponse: resp,
  hookEventName: 'PostToolUse',
});

const mkPre = () => JSON.stringify({
  sessionId: SESSION,
  toolName: 'mcp_github_mcp_se_push_files',
  toolInput: { files: [{ path: 'x', content: 'y' }] },
  hookEventName: 'PreToolUse',
});

test('EC6: 权限错误 PostToolUse → allow + 停止重试指引（FR-007 首次失败即停）', async () => {
  const r = await run('loop-guard', mkPost('Error: 403 Resource not accessible by integration'), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow', 'PostToolUse 不阻断（结果已发生）');
  assert.match(r.systemMessage, /权限错误不可重试/);
  assert.match(r.hookSpecificOutput.additionalContext, /停止重试/);
});

test('EC7: 权限标记后同类 PreToolUse 重试直接拦截（FR-008，无需计数达标）', async () => {
  await run('loop-guard', mkPost('Error: 403 Forbidden'), {});
  const retry = await run('loop-guard', mkPre(), {});
  assert.equal(retry.hookSpecificOutput.permissionDecision, 'deny', '权限错误重试直接拦截');
  assert.match(retry.hookSpecificOutput.permissionDecisionReason, /权限错误重试拦截/);
});

test('EC8: #942 补充实证模拟——GitHub MCP 连续 403 第 1 次即停（AC-013）', async () => {
  // 反事实：#942 中 GitHub MCP 连续 3 次 403 才被熔断拦截；修复后第 1 次即停 + 重试即拦
  await run('loop-guard', mkPost('403 Resource not accessible'), {});
  const r1 = await run('loop-guard', mkPre(), {});
  assert.equal(r1.hookSpecificOutput.permissionDecision, 'deny', '第 1 次重试即拦截');
  const r2 = await run('loop-guard', mkPre(), {});
  assert.equal(r2.hookSpecificOutput.permissionDecision, 'deny', '第 2 次重试仍拦截（持续）');
});

test('EC9: 瞬时错误重试 1-2 次放行（AC-009 合法重试保留）', async () => {
  await run('loop-guard', mkPost('ETIMEDOUT after 30000ms'), {});
  // 瞬时错误不置权限标记 → PreToolUse 正常放行（指纹计数另算）
  const r = await run('loop-guard', mkPre(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow', '瞬时错误不触发权限拦截');
});

test('EC10: 换工具不受权限标记影响（拦截粒度=同工具）', async () => {
  await run('loop-guard', mkPost('403 Forbidden'), {});
  const mkOther = JSON.stringify({
    sessionId: SESSION,
    toolName: 'read_file', // 豁免工具
    toolInput: { filePath: '/tmp/x' },
    hookEventName: 'PreToolUse',
  });
  const r = await run('loop-guard', mkOther, {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow', '其他工具不受影响');
});
