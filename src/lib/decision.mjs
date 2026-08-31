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
 * 构造 deny 决策（loop-guard 拦截时使用）。
 * @param {string} reason
 * @param {string} [eventName]
 */
export function buildDeny(reason, eventName = 'PreToolUse') {
  return buildDecision('deny', reason, eventName);
}

/** 构造 allow/continue 决策 */
export function buildAllow(reason = '', eventName = '') {
  return buildDecision('allow', reason, eventName);
}
