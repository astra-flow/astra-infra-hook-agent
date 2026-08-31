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

  // 指纹：工具名 + 参数（稳定序列化）
  const fingerprint = crypto
    .createHash('sha256')
    .update(toolName + JSON.stringify(stableSerialize(toolInput || {})))
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

/** 稳定序列化（键排序，避免 key 顺序导致指纹漂移） */
function stableSerialize(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(stableSerialize);
  return Object.keys(obj).sort().reduce((acc, k) => {
    acc[k] = stableSerialize(obj[k]);
    return acc;
  }, {});
}

/** 工具参数摘要（截断 200 字符） */
function summarizeToolInput(toolInput) {
  try {
    const s = JSON.stringify(toolInput);
    return s.length > 200 ? `${s.slice(0, 200)}...` : s;
  } catch {
    return String(toolInput);
  }
}
