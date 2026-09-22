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
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
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
  const { hookName, toolName, sessionId, durationMs, now = new Date(), decisionDetail } = context;
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
    // #1020 决策明细（可空，向后兼容——旧消费方忽略未知字段）：
    // nudge / tool_streak_breaker / permission_block / fingerprint_deny / fingerprint_ask
    decision_detail: decisionDetail ?? null,
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
 * @param {object} context {hookName, toolName, sessionId, durationMs, now?, decisionDetail?}
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

/** signals 缓冲文件默认路径（XDG，与 audit.jsonl 同目录；ASTRA_SIGNALS_FILE 可覆盖） */
export function defaultSignalsFile() {
  const base = process.env.ASTRA_SIGNALS_FILE;
  if (base) return base;
  const dir = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  try {
    mkdirSync(join(dir, 'astra-hook'), { recursive: true });
    return join(dir, 'astra-hook', 'signals.jsonl');
  } catch {
    try {
      mkdirSync(join(tmpdir(), 'astra-hook'), { recursive: true });
      return join(tmpdir(), 'astra-hook', 'signals.jsonl');
    } catch {
      return '/dev/null'; // 最终兑底：写入黑洞，fail-open
    }
  }
}

/**
 * signals 留痕写入（#1020 FR-011，R4 决策：JSONL 缓冲 + astra metrics sync 补偿入 PG）
 *
 * 熔断事件（tool_streak_breaker）触发时由 loop-guard 旁路调用。
 * 行格式（与 PG signals 表字段对应，layer 直写——002 迁移已交付 layer 列）：
 *   {"ts":"...","source_issue_id":1020,"signal_type":"gap","layer":"L2",
 *    "direction":"backward","description":"...","status":"pending","session_id":"..."}
 *
 * source_issue_id 来源：session-issue-link 文件（memories/session/issue-link.md，
 * 行格式 `session=<id> | issue=#N` 契约已有）解析；无关联会话置 null。
 *
 * fail-open：任何异常静默吞掉——JSONL 本身就是本地日志（降级路径），
 * 写失败不阻塞拦截动作（FR-011 降级语义）。
 *
 * @param {object} signal {signalType, layer, description, sessionId, sourceIssueId?}
 * @param {object} [deps] 依赖注入（测试用）：{file, writeFn, clock}
 * @returns {boolean} 写入是否成功
 */
export function writeSignal(signal, deps = {}) {
  try {
    const file = deps.file ?? defaultSignalsFile();
    const writeFn = deps.writeFn ?? appendFileSync;
    const now = deps.clock ? deps.clock() : new Date();
    const record = {
      ts: now.toISOString(),
      source_issue_id: signal.sourceIssueId ?? null,
      signal_type: signal.signalType ?? 'gap',
      layer: signal.layer ?? 'L2',
      direction: signal.direction ?? 'backward',
      description: signal.description ?? '',
      status: signal.status ?? 'pending',
      session_id: signal.sessionId ?? null,
    };
    const line = clampLine(JSON.stringify(record));
    writeFn(file, line + '\n', { flag: 'a' }); // O_APPEND：并发追加原子
    return true;
  } catch {
    return false; // fail-open：留痕失败不阻塞拦截（FR-011）
  }
}

/**
 * 从 session-issue-link 文件解析会话关联的 Issue 编号（signals source_issue_id 来源）
 * 行格式契约：`- <ts> | <event> | session=<id> | issue=#N`（session-link.mjs 同源）
 * @param {string} sessionId
 * @param {object} [deps] 依赖注入（测试用）：{file, readFn}
 * @returns {number|null} Issue 编号；无关联/文件缺失返回 null
 */
export function resolveSourceIssue(sessionId, deps = {}) {
  try {
    const file = deps.file ?? process.env.ASTRA_SESSION_LINK_FILE
      ?? join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'astra-hook', 'issue-link.md');
    const readFn = deps.readFn ?? readFileSync;
    if (!existsSync(file)) return null;
    const lines = readFn(file, 'utf8').split('\n');
    // 倒序找最近一条该 session 的关联（多 Issue 会话取最新）
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(new RegExp(`session=${String(sessionId).replace(/[^a-zA-Z0-9._-]/g, '_')} \\| issue=#(\\d+)`));
      if (m) return parseInt(m[1], 10);
    }
    return null;
  } catch {
    return null; // fail-open：解析失败不阻塞 signals 写入
  }
}
