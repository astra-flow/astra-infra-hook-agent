/**
 * loop-guard.mjs — PreToolUse 重复执行检测（防死循环）
 *
 * 迁移自 .github/hooks/loop-guard.sh，机制对齐：
 *   - crypto sha256 指纹（替代 shasum）
 *   - 连续 N 次相同指纹 → deny（默认 3 次）
 *   - HOT_TOOLS 预过滤（CP-03）：非白名单工具直接跳过，避免无关调用开销
 *   - 状态存 ~/.astra/hooks/loop-guard/<sessionId>.json（原子写 + 文件锁）
 *
 * 输出：allow（正常）/ deny（连续重复拦截）/ 默认 fail-open
 */
import crypto from 'node:crypto';
import { buildDeny, buildAllow } from '../lib/decision.mjs';
import { updateState } from '../lib/state.mjs';
import { isHotTool } from '../lib/validate.mjs';

/**
 * @param {object} input - 归一化输入（camelCase）
 * @param {object} meta - hook 元数据
 */
export default async function loopGuard(input, meta, { debug = false } = {}) {
  const { toolName, toolInput, sessionId, hookEventName } = input;

  // 预过滤：仅对高频易重复工具做检测（CP-03，避免每次 spawn 都做状态 IO）
  if (!isHotTool(toolName, meta.hotTools)) {
    if (debug) console.error(`[loop-guard] tool "${toolName}" not hot, skip`);
    return buildAllow('loop-guard: tool not monitored');
  }

  if (!sessionId) return buildAllow('loop-guard: no session');

  // 指纹：工具名 + 参数。性能优化（perf High #2）：
  // 不做全量深拷贝+键排序，仅对 JSON 字符串化结果截断（FINGERPRINT_MAX）再 hash。
  // 截断保留参数前缀足以区分不同调用；超大输入（create_file/read_file）不再 O(n) 深拷贝。
  const fingerprint = crypto
    .createHash('sha256')
    .update(toolName + stableFingerprint(toolInput))
    .digest('hex');

  const threshold = meta.threshold || 3;

  // 原子读-改-写：维护该 session 的连续指纹历史
  const state = await updateState('loop-guard', sessionId, (prev) => {
    const hist = (prev && Array.isArray(prev.history)) ? prev.history : [];
    // 相同指纹计数
    let streak = (prev && prev.streak && prev.lastFp === fingerprint) ? prev.streak : 0;
    streak += 1;
    const nextHist = [...hist, fingerprint].slice(-(meta.maxHistory || 50));
    return { history: nextHist, streak, lastFp: fingerprint, updatedAt: Date.now() };
  });

  const streak = state?.streak || 1;

  // 连续达到阈值 → deny
  if (streak >= threshold) {
    const summary = summarizeToolInput(toolInput);
    return buildDeny(
      `[防循环拦截] 检测到重复执行：工具 \`${toolName}\` 已连续调用 ${streak} 次且无进展。\n\n` +
      `- 最近一次参数：\`${summary}\`\n` +
      `- 原因：相同工具 + 相同参数重复执行，疑似陷入死循环\n` +
      `- 要求：立即停止重复，改用其他方案；若确实无法推进，请向用户报告当前阻塞状态并等待指示，不要继续尝试变体。`,
      hookEventName || 'PreToolUse'
    );
  }

  return buildAllow(`loop-guard: streak=${streak}/${threshold}`, hookEventName || 'PreToolUse');
}

/** 指纹输入截断上限（防超大 toolInput 全量 hash） */
const FINGERPRINT_MAX = 2048;

/**
 * 稳定指纹源：JSON 字符串化 + 截断。
 * - 不做键排序/深拷贝（性能）：参数对象键序通常稳定（同一工具同一调用方），
 *   即便键序漂移导致指纹不同，最坏结果是少拦截一次重复，可接受（fail-open 语义）。
 * - 截断保留前缀，足以区分不同参数内容。
 */
function stableFingerprint(obj) {
  let s;
  try {
    s = JSON.stringify(obj || {});
  } catch {
    s = String(obj);
  }
  return s.length > FINGERPRINT_MAX ? s.slice(0, FINGERPRINT_MAX) : s;
}

/** 敏感键匹配（隐藏 content/command/apiKey 等） */
const SENSITIVE_KEY_RE = /(content|command|body|api[_-]?key|token|password|secret|code)/i;

/**
 * 工具参数摘要（deny 理由用）：键名化 + 脱敏，避免回显敏感参数（sec Medium）。
 * 输出形如：`{ filePath: "/tmp/x", content: [REDACTED] }`
 */
function summarizeToolInput(toolInput) {
  try {
    if (toolInput === null || typeof toolInput !== 'object') return '[unserializable]';
    const parts = [];
    for (const [k, v] of Object.entries(toolInput)) {
      if (SENSITIVE_KEY_RE.test(k)) {
        parts.push(`${k}: [REDACTED]`);
      } else if (typeof v === 'string') {
        parts.push(`${k}: ${v.length > 80 ? `${v.slice(0, 80)}...` : v}`);
      } else if (typeof v === 'object') {
        // 嵌套对象统一输出键名+长度（sec 复审 Medium 修复）：
        // 避免 ≤80 字符时完整打印嵌套对象的敏感键值（如 {config:{apiKey:"sk-..."}}）
        parts.push(`${k}: {keys: ${Object.keys(v).join(',') || '(empty)'}}`);
      } else {
        parts.push(`${k}: ${String(v)}`);
      }
    }
    return `{ ${parts.join(', ')} }`;
  } catch {
    return '[unserializable]';
  }
}
