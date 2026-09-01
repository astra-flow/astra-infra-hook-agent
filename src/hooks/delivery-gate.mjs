/**
 * delivery-gate.mjs — 交付门禁检查（#915：SDLC artifact 存在性门禁）
 *
 * Playbook 主线三（反馈闭环）落地：交付门禁行为 hook 化，确定性执行（零 token）。
 * 复用 hook-agent 架构：新 hook 模块 + 元数据注册 + evals。
 *
 * 门禁规则（PreToolUse，拦截写操作类工具）：
 *   - /design 前置：spec.md 必须存在（analyze 产出，#914）
 *   - /implement 前置：task-breakdown 必须存在（design 产出，#892）
 *
 * 触发方式：Agent 调用 create_file/replace_string_in_file 等写工具时，
 * 若当前处于 design/implement 阶段（由 env ASTRA_SDLC_PHASE 声明）且对应
 * artifact 缺失 → deny + 纠偏指引（告知应先执行哪个 prompt）。
 *
 * 阶段声明契约：Agent 在执行 /design 或 /implement 时设置 env
 *   ASTRA_SDLC_PHASE=design | implement
 * 未声明阶段 → 放行（fail-open，不误伤非 SDLC 流程的常规编码）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildDeny, buildAllow } from '../lib/decision.mjs';

/** 写操作类工具（门禁拦截范围） */
const WRITE_TOOLS = new Set([
  'create_file', 'replace_string_in_file', 'multi_replace_string_in_file',
  'insert_edit_into_file', 'Write', 'Edit', 'NotebookEdit',
]);

/** 阶段 → 必需 artifact 映射 */
const PHASE_ARTIFACTS = {
  design: {
    artifact: 'spec.md',
    glob: 'docs/03-agile/artifacts/specs/spec-*.md',
    prompt: '/analyze',
    message: 'spec.md（需求分析 artifact）',
  },
  implement: {
    artifact: 'task-breakdown',
    glob: 'docs/03-agile/artifacts/task-breakdowns/task-breakdown-*.md',
    prompt: '/design',
    message: 'task-breakdown（任务拆解 artifact）',
  },
};

/**
 * @param {object} input - 归一化输入（camelCase）
 * @param {object} meta - hook 元数据
 */
export default async function deliveryGate(input, meta, { debug = false } = {}) {
  const { toolName, hookEventName } = input;

  // 仅拦截写操作工具（读操作放行——检查 artifact 本身就需要读）
  if (!WRITE_TOOLS.has(toolName)) {
    return buildAllow('delivery-gate: not a write tool');
  }

  // 阶段声明：未声明 → 放行（fail-open，不误伤常规编码）
  const phase = process.env.ASTRA_SDLC_PHASE || '';
  if (!phase) return buildAllow('delivery-gate: no SDLC phase declared');

  const rule = PHASE_ARTIFACTS[phase];
  if (!rule) return buildAllow(`delivery-gate: unknown phase "${phase}"`);

  // artifact 存在性检查（工作区根 = cwd 或 env 注入）
  const root = process.env.ASTRA_WORKSPACE_ROOT || process.cwd();
  const artifactDir = path.join(root, path.dirname(rule.glob));

  let exists = false;
  try {
    if (fs.existsSync(artifactDir)) {
      const files = fs.readdirSync(artifactDir);
      const prefix = path.basename(rule.glob).replace(/-\*\.md$/, '-');
      exists = files.some((f) => f.startsWith(prefix) && f.endsWith('.md'));
    }
  } catch (err) {
    if (debug) console.error(`[delivery-gate] check failed: ${err.message}`);
    return buildAllow('delivery-gate: check failed (fail-open)');
  }

  if (exists) {
    return buildAllow(`delivery-gate: ${rule.artifact} present`, hookEventName || 'PreToolUse');
  }

  // artifact 缺失 → deny + 纠偏指引（含恢复路径）
  return buildDeny(
    `[交付门禁] 当前处于 **${phase}** 阶段，但必需 artifact \`${rule.message}\` 不存在。\n\n` +
    `- SDLC artifact 链：intent(Issue) → spec.md → task-breakdown.md → 代码\n` +
    `- 纠偏选项（任选其一）：\n` +
    `  1. 先执行 \`${rule.prompt}\` 产出该 artifact（推荐，符合交付流程）\n` +
    `  2. 若本次变更不属于该 SDLC 阶段，取消 env ASTRA_SDLC_PHASE 声明后重试\n` +
    `- 禁止：跳过 artifact 直接编码（破坏可追溯性）`,
    hookEventName || 'PreToolUse',
    `[astra-hook delivery-gate] ${phase} 阶段缺少必需 artifact ${rule.artifact}。` +
    `请先执行 ${rule.prompt} 产出 artifact，或取消 ASTRA_SDLC_PHASE 声明。这不是故障，是交付门禁。`
  );
}
