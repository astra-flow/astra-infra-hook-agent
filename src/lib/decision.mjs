/**
 * decision.mjs — 决策输出构造（CP-01 运行时输出协议）
 *
 * 输出协议（VS Code Copilot Hooks，兼容 Claude Code）：
 *   { hookSpecificOutput: { hookEventName, permissionDecision, permissionDecisionReason } }
 *
 * permissionDecision: "allow" | "deny" | "ask"
 */

/** fail-open 兜底决策（任何异常时使用，绝不阻塞工具调用） */
export const FAIL_OPEN_DECISION = {
  hookSpecificOutput: {
    hookEventName: '',
    permissionDecision: 'allow',
    permissionDecisionReason: 'astra-hook: runtime fail-open',
  },
};

/**
 * 构造 hook 决策。
 * @param {'allow'|'deny'|'ask'} decision
 * @param {string} reason
 * @param {string} [eventName]
 * @returns {object}
 */
export function buildDecision(decision, reason, eventName = '') {
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
}

/**
 * 构造熔断决策：终止整个 Agent 回合（deny 单次调用之上的升级）。
 *
 * 背景：per-call deny + systemMessage 对陷入"计划固位"失败模式的模型无效
 * （#899 事故：拦截 168 次仍重试）。hooks 协议支持 continue:false + stopReason
 * 终止整个回合——这是模型无法忽略的强制停止信号。
 *
 * @param {string} reason - permissionDecisionReason（UI 审批理由）
 * @param {string} systemMessage - 注入模型上下文的终止说明
 * @param {string} [eventName]
 */
export function buildCircuitBreaker(reason, systemMessage, eventName = 'PreToolUse') {
  return {
    continue: false,
    stopReason: systemMessage,
    systemMessage,
    hookSpecificOutput: {
      hookEventName: eventName,
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

/**
 * 构造 deny 决策。
 * @param {string} reason - permissionDecisionReason（UI 审批理由）
 * @param {string} [eventName]
 * @param {string} [systemMessage] - 顶层系统消息（注入模型上下文，确保 Agent 拿到纠偏指引）。
 *   背景：permissionDecisionReason 主要面向用户 UI；VS Code 拦截后 Agent 侧可能只看到
 *   通用"调用被拒绝"错误而看不到原因 → 原样重试 → 拦截死循环。systemMessage 保证
 *   纠偏信息到达 Agent（平台若不支持该字段则忽略，无副作用）。
 */
export function buildDeny(reason, eventName = 'PreToolUse', systemMessage = '') {
  const out = buildDecision('deny', reason, eventName);
  if (systemMessage) out.systemMessage = systemMessage;
  return out;
}

/** 构造 allow/continue 决策 */
export function buildAllow(reason = '', eventName = '') {
  return buildDecision('allow', reason, eventName);
}
