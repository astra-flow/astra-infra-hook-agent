/**
 * audit.mjs — hook 决策审计写入模块（#993）
 *
 * 职责：在 runtime 决策统一出口旁路追加审计记录（JSONL 缓冲，后续由
 * 主仓 `astra metrics sync` 同步入 PG hook_audit 表）。
 *
 * 设计约束（plan.md C1 / 关键设计决策 1/3）：
 * - fail-open 优先：任何审计异常静默吞掉，绝不影响决策输出
 * - 时延预算：appendFileSync 微秒级同步写，审计路径 < 5ms（测试断言）
 * - 并发写安全：单行 JSON 序列化后 < 1KB，POSIX O_APPEND 单次 write
 *   原子性（≤ PIPE_BUF 4KB）保证并发追加无交错损坏
 * - 零依赖：仅 node:fs / node:path / node:os 标准库
 *
 * JSONL 行格式（跨仓契约，主仓 fixture 契约测试消费）：
 *   {"ts":"2026-09-14T08:00:00.000Z","hook_name":"loop-guard","tool_name":"Bash",
 *    "decision":"deny","reason":"...","session_id":"...","duration_ms":12}
 *
 * 字段与 PG hook_audit 表 7 字段一一对应（ts/hook_name/tool_name/decision/
 * reason/session_id/duration_ms）。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

/** 审计行序列化后的大小上限（字节）——超过则截断 reason，保证 O_APPEND 原子写 */
export const MAX_LINE_BYTES = 1024;

/** 默认缓冲文件路径（可用 ASTRA_HOOK_AUDIT_FILE 覆盖） */
export function defaultAuditFile() {
  const base = process.env.ASTRA_HOOK_AUDIT_FILE;
  if (base) return base;
  // 用户级缓冲目录：优先 XDG，退回 tmp
  const dir = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  try {
    mkdirSync(join(dir, 'astra-hook'), { recursive: true });
    return join(dir, 'astra-hook', 'audit.jsonl');
  } catch {
    // 目录创建失败（只读文件系统等）→ 退回 tmp；tmp 也失败由 writeAudit 兜底
    try {
      mkdirSync(join(tmpdir(), 'astra-hook'), { recursive: true });
      return join(tmpdir(), 'astra-hook', 'audit.jsonl');
    } catch {
      return '/dev/null'; // 最终兜底：写入黑洞，fail-open
    }
  }
}

/**
 * 截断 reason 使整行不超过 MAX_LINE_BYTES（保证原子写前提）
 * @param {string} line 已序列化的 JSONL 行
 * @returns {string} 不超限的行
 */
export function clampLine(line) {
  const size = Buffer.byteLength(line, 'utf8');
  if (size <= MAX_LINE_BYTES) return line;
  // 逐字符回退 reason 长度（简单可靠：重序列化直到达标，最多循环 reason 长度次）
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return JSON.stringify({ truncated: true }); // 理论不可达：入参必为合法 JSON 行
  }
  const overflow = size - MAX_LINE_BYTES;
  const reason = typeof obj.reason === 'string' ? obj.reason : '';
  obj.reason = reason.slice(0, Math.max(0, reason.length - overflow - 16)) + '…[clamped]';
  const clamped = JSON.stringify(obj);
  // 极端情况（reason 极短仍超限）：丢弃 reason
  return Buffer.byteLength(clamped, 'utf8') <= MAX_LINE_BYTES
    ? clamped
    : JSON.stringify({ ...obj, reason: null });
}

/**
 * 构造审计记录对象（纯函数，便于测试）
 * @param {object} decision runtime 决策结果（含 hookSpecificOutput）
 * @param {object} context 上下文（hookName/toolName/sessionId/durationMs/now）
 * @returns {object} 审计记录（7 字段）
 */
export function buildAuditRecord(decision, context) {
  const { hookName, toolName, sessionId, durationMs, now = new Date() } = context;
  const output = decision?.hookSpecificOutput ?? {};
  const permissionDecision = output.permissionDecision ?? decision?.decision ?? 'allow';
  // decision 枚举归一：allow/deny/ask 之外的值归 allow（防御性，不抛错）
  const normalized = ['allow', 'deny', 'ask'].includes(permissionDecision)
    ? permissionDecision
    : 'allow';
  return {
    ts: now.toISOString(),
    hook_name: hookName ?? '',
    tool_name: toolName ?? null,
    decision: normalized,
    reason: output.reason ?? decision?.reason ?? null,
    session_id: sessionId ?? null,
    duration_ms: Number.isFinite(durationMs) ? Math.round(durationMs) : null,
  };
}

/**
 * 提取会话标识（从 hook stdin 输入或环境）
 * @param {string} stdinJson hook 输入原文
 * @returns {string|null}
 */
export function extractSessionId(stdinJson) {
  try {
    const parsed = JSON.parse(stdinJson);
    return parsed.session_id ?? parsed.sessionId ?? null;
  } catch {
    return null;
  }
}

/**
 * 审计写入主入口（旁路调用，任何异常静默吞掉）
 *
 * @param {object} decision runtime 决策结果
 * @param {object} context {hookName, toolName, sessionId, durationMs, now?}
 * @param {object} [deps] 依赖注入（测试用）：{file, writeFn, clock}
 * @returns {boolean} 写入是否成功（仅供测试/诊断，调用方不得据此改变决策行为）
 */
export function writeAudit(decision, context, deps = {}) {
  try {
    const file = deps.file ?? defaultAuditFile();
    const writeFn = deps.writeFn ?? appendFileSync;
    const record = buildAuditRecord(decision, context);
    const line = clampLine(JSON.stringify(record));
    writeFn(file, line + '\n', { flag: 'a' }); // O_APPEND：并发追加原子
    return true;
  } catch {
    // fail-open：审计失败绝不影响决策（静默降级，缓冲续传由 sync 补偿）
    return false;
  }
}
