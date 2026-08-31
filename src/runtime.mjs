/**
 * runtime.mjs — Hook 统一运行时入口
 *
 * 职责链：
 *   stdin JSON → 解析 → 平台归一化（normalize）→ 输入校验（validate）
 *   → 分发到对应 hook 模块 → 输出决策 JSON（decision）
 *
 * 关键平台约束（决定性）：VS Code PreToolUse command hook 崩溃/非零退出
 * 默认 deny 工具调用（fail-closed），timeout 才 fail-open。因此本运行时
 * 必须自身保证 fail-open——任何异常/未知 hook/解析失败都输出 continue
 * 决策，绝不阻塞正常工具调用。
 */
import { normalizeInput } from './lib/normalize.mjs';
import { validateInput } from './lib/validate.mjs';
import { buildDecision, FAIL_OPEN_DECISION } from './lib/decision.mjs';
import { loadHookMetadata } from './lib/config.mjs';

/**
 * 执行指定 hook。
 * @param {string} hookName - hook 名（loop-guard / decision-log / session-issue-link）
 * @param {string} stdin - 来自 VS Code/Claude Code 的原始 stdin JSON 字符串
 * @param {{debug?: boolean}} opts
 * @returns {Promise<object>} 决策 JSON（永远合法，fail-open 兜底）
 */
export async function run(hookName, stdin, opts = {}) {
  const { debug = false } = opts;

  try {
    // 1. 解析 stdin JSON
    let rawInput;
    try {
      rawInput = JSON.parse(stdin || '{}');
    } catch {
      // stdin 非 JSON → fail-open
      if (debug) console.error('[astra-hook] invalid stdin JSON, fail-open');
      return FAIL_OPEN_DECISION;
    }

    // 2. 平台字段归一化（snake_case → camelCase）
    const input = normalizeInput(rawInput);
    if (debug) console.error('[astra-hook] normalized input:', JSON.stringify(input));

    // 3. 输入白名单校验（无效输入 fail-open，不阻塞）
    const validation = validateInput(input);
    if (!validation.valid) {
      if (debug) console.error(`[astra-hook] validation failed: ${validation.reason}, fail-open`);
      return FAIL_OPEN_DECISION;
    }

    // 4. 加载 hook 元数据
    const meta = loadHookMetadata(hookName);
    if (!meta) {
      if (debug) console.error(`[astra-hook] unknown hook "${hookName}", fail-open`);
      return FAIL_OPEN_DECISION;
    }

    // 5. 预过滤：事件类型不匹配 → 直接 continue（性能：避免无关逻辑）
    const eventName = input.hookEventName || '';
    if (meta.events && meta.events.length > 0 && !meta.events.includes(eventName)) {
      if (debug) console.error(`[astra-hook] event "${eventName}" not in ${meta.events.join(',')}, skip`);
      return buildDecision('allow', `${hookName}: event not applicable`);
    }

    // 6. 动态加载 hook 模块并执行
    const mod = await import(`./hooks/${hookName}.mjs`);
    const result = await mod.default(input, meta, { debug });

    // hook 返回合法决策则原样返回；否则 fail-open
    if (result && typeof result === 'object' && result.hookSpecificOutput) {
      return result;
    }
    return buildDecision('allow', `${hookName}: no decision, fail-open`);
  } catch (err) {
    // 任何异常 → fail-open（绝不 deny 正常工具调用）
    if (debug) console.error(`[astra-hook] runtime error: ${err?.message || err}, fail-open`);
    return FAIL_OPEN_DECISION;
  }
}
