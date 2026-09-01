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
import { buildDeny, buildAllow, buildCircuitBreaker } from '../lib/decision.mjs';
import { updateState } from '../lib/state.mjs';
import { isExemptTool } from '../lib/validate.mjs';

/**
 * @param {object} input - 归一化输入（camelCase）
 * @param {object} meta - hook 元数据
 */
export default async function loopGuard(input, meta, { debug = false } = {}) {
  const { toolName, toolInput, sessionId, hookEventName } = input;

  // 预过滤（2026-09-01 语义反转）：豁免名单模式——只读工具跳过，其余全部监控
  if (isExemptTool(toolName, meta.exemptTools)) {
    if (debug) console.error(`[loop-guard] tool "${toolName}" exempt, skip`);
    return buildAllow('loop-guard: tool exempt');
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

  // 连续达到阈值 → deny（含 Agent 纠偏指引，确保 Agent 能采取行动而非盲目重试）
  if (streak >= threshold) {
    const summary = summarizeToolInput(toolInput);
    const breakerLimit = meta.breakerLimit || 8;

    // 熔断器（2026-09-01）：连续拦截达 breakerLimit → 终止整个 Agent 回合。
    // deny+systemMessage 对陷入"计划固位"失败模式的模型无效（#899 事故：
    // 拦截 168 次仍重试），唯一无法忽略的信号是平台强制终止回合。
    if (streak >= breakerLimit) {
      return buildCircuitBreaker(
        `[防循环熔断] 工具 \`${toolName}\` 已被连续拦截 ${streak - threshold + 1} 次（相同参数第 ${streak} 次调用），Agent 回合被强制终止。\n\n` +
        `- 最近一次参数：\`${summary}\`\n` +
        `- 触发条件：连续 ${breakerLimit} 次拦截后仍未改变行为\n` +
        `- 恢复方式：用户开启新回合后，必须换用不同方案或修改参数，严禁原样重试`,
        `[astra-hook loop-guard 熔断] 工具 ${toolName} 连续 ${streak} 次相同参数调用，已拦截 ${streak - threshold + 1} 次仍未改变行为，本回合被强制终止。` +
        `这不是故障。新回合中请换用不同方案、修改参数、或直接向用户报告阻塞——严禁原样重试。`,
        hookEventName || 'PreToolUse'
      );
    }

    // 连续拦截升级：streak 超过阈值 2 次以上，说明 Agent 未响应纠偏指引，升级警告
    const escalation =
      streak >= threshold + 2
        ? `\n- ⚠️ 升级警告：本工具已被连续拦截 ${streak - threshold + 1} 次，你仍未改变行为。达到 ${breakerLimit} 次将强制终止本回合。请立即停止该工具调用，直接向用户文字报告阻塞状态。`
        : '';
    return buildDeny(
      `[防循环拦截] 检测到重复执行：工具 \`${toolName}\` 已连续调用 ${streak} 次且无进展。\n\n` +
      `- 最近一次参数：\`${summary}\`\n` +
      `- 原因：相同工具 + 相同参数重复执行，疑似陷入死循环\n` +
      `- 纠偏选项（任选其一）：\n` +
      `  1. 改用其他工具或方案完成同一目标\n` +
      `  2. 若参数确需变化，修改参数后重试（参数变化会重置计数）\n` +
      `  3. 若确实无法推进，停止调用，向用户文字报告阻塞状态并等待指示\n` +
      `- 禁止：原样重试（会再次被拦截）或仅微调措辞后重试同一操作` +
      escalation,
      hookEventName || 'PreToolUse',
      // systemMessage：注入模型上下文，确保 Agent 拿到纠偏信息（而非只看到"被拒绝"）
      `[astra-hook loop-guard] 工具 ${toolName} 已连续 ${streak} 次以相同参数调用，本次调用已被阻止。` +
      `这不是瞬时故障，不会因重试而恢复。请立即改变行为：换方案 / 修改参数 / 或向用户报告阻塞。` +
      (streak >= threshold + 2 ? ` 已连续拦截 ${streak - threshold + 1} 次，达到 ${breakerLimit} 次将强制终止本回合。` : '')
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
