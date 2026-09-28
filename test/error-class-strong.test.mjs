/**
 * error-class-strong.test.mjs — error-class 强/弱模式判定回归（#1063 P1）
 *
 * 覆盖：
 *   1. AC-101：业务文本含裸关键词（403/Forbidden/permission denied，无错误形态）
 *      → 不判 permission（不置位）——误杀修复核心
 *   2. AC-102：真实错误形态（Error: 403 / 403 Forbidden / Error: permission denied）
 *      → 判 permission（原 EC1 回归保留）
 *   3. 内置兜底：配置缺失/空配置 → 内置 \b40[13]\b 状态码正则仍生效
 *   4. 配置兼容：旧 patterns 键 → 按弱模式处理（弱模式命中不置位）
 *   5. 弱模式命中返回 WEAK_PERMISSION（仅审计，不置位）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, loadErrorClasses, clearErrorClassesCache, ERROR_CLASSES } from '../src/lib/error-class.mjs';

test.beforeEach(() => {
  clearErrorClassesCache();
});

// ---------- AC-101：业务文本裸关键词不误判 ----------

test('S101: 正文含裸 403（如 Issue 评论/文档）→ 不判 permission', () => {
  // 活体实证场景：读取的评论文本含 "403" 字样但无错误形态
  assert.equal(
    classifyError('### 根因\n状态文件 {"permissionFlag":true} 由 PostToolUse 误判，原因是 error-classes.yaml 的裸 403 模式'),
    ERROR_CLASSES.TRANSIENT
  );
});

test('S102: 正文含 Forbidden/Unauthorized（业务文本）→ 不判 permission', () => {
  // 活体实证场景：文档/日志/代码内容含权限类英文词。
  // 设计决策（#1063）：Forbidden/Unauthorized 单独出现归弱模式（业务文本常见，
  // 如英文文档标题/术语表）；permission denied/access denied 归强模式（几乎只
  // 出现在错误响应，原 spec EC1-4 语义保留）。
  assert.equal(
    classifyError('Forbidden这个词出现在英文文档标题中'),
    ERROR_CLASSES.WEAK_PERMISSION
  );
  assert.equal(
    classifyError('Unauthorized 是 HTTP 语义的标准术语'),
    ERROR_CLASSES.WEAK_PERMISSION
  );
  assert.equal(
    classifyError('配置文件中出现 "permission denied" 字样用于说明历史缺陷'),
    ERROR_CLASSES.PERMISSION,
    'permission denied 短语归强模式（原 EC1-4 语义，几乎只在错误中出现）'
  );
});

test('S103: 正文含 401 但无错误形态（如文档举例）→ 不判 permission（强模式不命中）', () => {
  // "HTTP 401" 前缀无权限语义词绑定、无 Error 前缀 → 不强模式命中（第二轮实证：
  // 终端回显测试输出含 "HTTP 401" 字样也不应误杀）；无弱模式关键词 → transient
  assert.equal(
    classifyError('示例代码：HTTP 401 表示未认证，常用于演示'),
    ERROR_CLASSES.TRANSIENT
  );
  assert.equal(
    classifyError('状态码 401 在 OAuth 流程中的语义是未认证'),
    ERROR_CLASSES.TRANSIENT
  );
});

// ---------- AC-102：真实错误形态仍判 permission（回归保留） ----------

test('S104: Error: 403 形态 → PERMISSION（强模式+内置兜底）', () => {
  assert.equal(classifyError('Error: 403 Resource not accessible by integration'), ERROR_CLASSES.PERMISSION);
  assert.equal(classifyError('error code 403'), ERROR_CLASSES.PERMISSION);
});

test('S105: 403 Forbidden / 401 Unauthorized 组合 → PERMISSION（内置兜底 \b40[13]\b）', () => {
  assert.equal(classifyError('403 Forbidden'), ERROR_CLASSES.PERMISSION);
  assert.equal(classifyError('401 Unauthorized'), ERROR_CLASSES.PERMISSION);
  assert.equal(classifyError({ message: '403 Forbidden for this integration' }), ERROR_CLASSES.PERMISSION);
});

test('S106: Error: permission denied 前缀 → PERMISSION（强模式）', () => {
  assert.equal(classifyError('Error: permission denied: write to protected path'), ERROR_CLASSES.PERMISSION);
  assert.equal(classifyError('Error: access denied for user'), ERROR_CLASSES.PERMISSION);
});

// ---------- 内置兜底：配置缺失/空配置 ----------

test('S107: 内置兜底在配置缺失时由 loadErrorClasses 组装（真实配置含兜底）', () => {
  const cfg = loadErrorClasses();
  // 真实配置 permission 数组含内置兜底（错误上下文组合形态）
  assert.ok(
    cfg.permission.some((re) => re.source.includes('40[13]') || re.source.includes('403')),
    '内置兜底状态码正则已注入强模式'
  );
  assert.equal(classifyError('Error: 403 Resource not accessible by integration'), ERROR_CLASSES.PERMISSION);
});

test('S108: 显式空配置无内置兜底（测试注入场景）→ 不判 permission', () => {
  // 测试注入空配置时无内置兜底（内置兜底在 loadErrorClasses 组装，注入配置不包含）
  assert.equal(classifyError('403 forbidden', { permission: [], weakPermission: [], transient: [], rateLimit: [] }), ERROR_CLASSES.TRANSIENT);
});

// ---------- 配置兼容：旧 patterns 键 → 弱模式 ----------

test('S109: loadErrorClasses 真实配置 → 强模式含内置兜底 + 弱模式已编译', () => {
  const cfg = loadErrorClasses();
  assert.ok(cfg.permission.length > 0, '强模式含内置兜底');
  assert.ok(cfg.weakPermission.length > 0, '弱模式已编译');
  assert.ok(cfg.transient.length > 0);
  assert.ok(cfg.rateLimit.length > 0);
});

test('S110: 旧配置兼容——patterns 键内容归弱模式（保守 fail-open）', () => {
  // 模拟旧配置形态：permission 节只有 patterns 键（无 strong/weak 子键）→ 弱模式
  const oldCfg = {
    permission: [],
    weakPermission: [/403/, /401/, /Forbidden/, /permission denied/, /Unauthorized/],
    transient: [],
    rateLimit: [],
  };
  assert.equal(classifyError('正文含 403 字样但无错误形态', oldCfg), ERROR_CLASSES.WEAK_PERMISSION);
  assert.equal(classifyError('403 Forbidden', oldCfg), ERROR_CLASSES.WEAK_PERMISSION, '旧配置弱模式不置位（误杀消除）');
  // 注入配置无强模式时，真实错误形态也保守归弱模式（不置位）——真实强模式
  // 由 loadErrorClasses 组装的内置兜底承担（S104/S105 已覆盖真实配置场景）
  assert.equal(classifyError('Error: 403', oldCfg), ERROR_CLASSES.WEAK_PERMISSION, '注入无强模式 → 保守弱模式');
});

// ---------- 分类优先级：强模式 > rate-limit > transient > 弱模式 ----------

test('S111: 强模式优先于弱模式——同一文本强模式命中判 PERMISSION', () => {
  assert.equal(classifyError('403 Forbidden (rate limit 429 also present)'), ERROR_CLASSES.PERMISSION);
});

test('S112: rate-limit 优先于弱模式', () => {
  // 真实 rate-limit 响应优先于弱模式关键词（弱模式词不在 rate-limit 文本中）
  assert.equal(classifyError('429 too many requests, retry after 60s'), ERROR_CLASSES.RATE_LIMIT);
  // 若 rate-limit 响应同时含权限短语（罕见），强模式 permission 优先（安全优先）
  assert.equal(classifyError('Error: 429 too many requests (access denied)'), ERROR_CLASSES.PERMISSION);
});

test('S113: 弱模式不覆盖瞬时——无匹配归 transient', () => {
  assert.equal(classifyError('some unrelated output'), ERROR_CLASSES.TRANSIENT);
  assert.equal(classifyError(''), ERROR_CLASSES.TRANSIENT);
  assert.equal(classifyError(null), ERROR_CLASSES.TRANSIENT);
});
