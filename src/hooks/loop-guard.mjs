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
import { buildDeny, buildAsk, buildAllow, buildCircuitBreaker } from '../lib/decision.mjs';
import { updateState } from '../lib/state.mjs';
import { isExemptTool } from '../lib/validate.mjs';
import { loadBands } from '../lib/config.mjs';

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

  // 阈值优先级（#916）：bands.yaml（可调配置）> meta（HOOK_METADATA 内置）> 硬编码兜底
  const threshold = loadBands()['loop-guard']?.threshold || meta.threshold || 3;

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

  // 连续达到阈值 → 拦截（#957：deny 自动拦截对计划固位失败模式无效——#948 二次事故
  // 290 次拦截仍重试。升级为 ask 强制人工审批：模型无法绕过，用户可批准/拒绝/终止）
  if (streak >= threshold) {
    const summary = summarizeToolInput(toolInput);
    const bands = loadBands()['loop-guard'] || {};
    const breakerLimit = bands.breakerLimit || meta.breakerLimit || 8;
    // 升级阈值（#957 P0）：bands.yaml askThreshold > threshold+2 兜底
    const askThreshold = bands.askThreshold || threshold + 2;

    // 熔断器（#957 终态改 ask 兜底）：连续拦截达 breakerLimit → 强制人工审批。
    // 原设计为 continue:false 强制终止回合，但 #948 二次事故实证：VS Code 实际
    // 环境中熔断未能终止回合（Agent 熔断后仍重试至 290 次）。ask 是平台语义中
    // 唯一无法被模型自动绕过的停止信号——工具调用挂起等待用户确认。
    if (streak >= breakerLimit) {
      return buildAsk(
        `[防循环熔断·人工审批] 工具 \`${toolName}\` 已被连续拦截 ${streak - threshold + 1} 次（相同参数第 ${streak} 次调用），升级为强制人工审批。\n\n` +
        `- 最近一次参数：\`${summary}\`\n` +
        `- 触发条件：连续 ${breakerLimit} 次拦截后仍未改变行为\n` +
        `- 建议：拒绝本次调用，并要求 Agent 换用不同方案或直接报告阻塞状态`,
        hookEventName || 'PreToolUse',
        `[astra-hook loop-guard 熔断] 工具 ${toolName} 连续 ${streak} 次相同参数调用，已拦截 ${streak - threshold + 1} 次仍未改变行为，本次调用已升级为人工审批。` +
        `这不是瞬时故障，不会因重试而恢复。请立即停止该工具调用：换用不同方案、修改参数、或直接向用户文字报告阻塞状态——严禁原样重试。`
      );
    }

    // 连续拦截升级：streak 达到 askThreshold，说明 Agent 未响应纠偏指引，升级为 ask
    // （#957 P0：原升级警告仍为 deny 自动拦截，实证无效；ask 强制用户介入）
    if (streak >= askThreshold) {
      return buildAsk(
        `[防循环升级·人工审批] 工具 \`${toolName}\` 已被连续拦截 ${streak - threshold + 1} 次（相同参数第 ${streak} 次调用），Agent 未响应纠偏指引，升级为强制人工审批。\n\n` +
        `- 最近一次参数：\`${summary}\`\n` +
        `- 达到 ${breakerLimit} 次将保持人工审批直至行为改变\n` +
        `- 建议：拒绝本次调用，并要求 Agent 换用不同方案或直接报告阻塞状态`,
        hookEventName || 'PreToolUse',
        `[astra-hook loop-guard 升级] 工具 ${toolName} 已连续拦截 ${streak - threshold + 1} 次仍未改变行为，本次调用需用户确认。` +
        `这不是瞬时故障，不会因重试而恢复。请立即停止该工具调用：换用不同方案、修改参数、或直接向用户文字报告阻塞状态——严禁原样重试。`
      );
    }

    // 首次拦截（streak == threshold）：保留 deny + 正向指令（#957 P1a：
    // 业界 loop-breaker 采用正向措辞，明确告知替代动作而非否定式警告）
    return buildDeny(
      `[防循环拦截] 检测到重复执行：工具 \`${toolName}\` 已连续调用 ${streak} 次且无进展。\n\n` +
      `- 最近一次参数：\`${summary}\`\n` +
      `- 原因：相同工具 + 相同参数重复执行，疑似陷入死循环\n` +
      `- 下一步行动（任选其一）：\n` +
      `  1. 改用其他工具或方案完成同一目标\n` +
      `  2. 若参数确需变化，修改参数后重试（参数变化会重置计数）\n` +
      `  3. 若确实无法推进，停止调用，向用户文字报告阻塞状态并等待指示\n` +
      `- 注意：原样重试将被再次拦截；连续拦截 ${askThreshold} 次后将升级为人工审批`,
      hookEventName || 'PreToolUse',
      // systemMessage：注入模型上下文，确保 Agent 拿到纠偏信息（而非只看到"被拒绝"）
      `[astra-hook loop-guard] 工具 ${toolName} 已连续 ${streak} 次以相同参数调用，本次调用已被阻止。` +
      `这不是瞬时故障，不会因重试而恢复。请立即改变行为：换方案 / 修改参数 / 或向用户报告阻塞。` +
      ` 连续拦截 ${askThreshold} 次后将升级为人工审批。`
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
