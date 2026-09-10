/**
 * delivery-stage-label.mjs — 交付门禁（警告）：阶段标签一致性校验（#976）
 *
 * 规则：阶段推进时（PostToolUse），校验 Issue/工作项的 stage:X 标签与
 * ASTRA_SDLC_PHASE 声明的实际阶段一致——不符则警告（标签是状态提示，
 * 不影响实际交付）。
 *
 * 标签来源：当前分支名或 env ASTRA_STAGE_LABEL（Agent 推进阶段时声明）。
 * 一致性规则：ASTRA_STAGE_LABEL 与 ASTRA_SDLC_PHASE 均声明时不一致 → 警告。
 *
 * 阶段声明契约：未声明 ASTRA_SDLC_PHASE → 放行（fail-open）。
 */
import { buildDecision } from '../lib/decision.mjs';

/** 阶段 → 互斥标签映射（stage-labels.md 定义） */
const PHASE_LABELS = {
  specify: 'stage:specify',
  plan: 'stage:plan',
  implement: 'stage:feature',
  test: 'stage:testing',
  converge: 'stage:review',
};

/**
 * @param {object} input - 归一化输入（camelCase）
 * @param {object} meta - hook 元数据
 */
export default async function deliveryStageLabel(input, meta, { debug = false } = {}) {
  const { hookEventName } = input;

  const phase = process.env.ASTRA_SDLC_PHASE || '';
  if (!phase) {
    return buildDecision('allow', 'delivery-stage-label: no SDLC phase declared');
  }

  // 标签来源：Agent 推进阶段时声明（未声明 → 放行，无法校验）
  const declaredLabel = process.env.ASTRA_STAGE_LABEL || '';
  if (!declaredLabel) {
    return buildDecision('allow', 'delivery-stage-label: no stage label declared');
  }

  const expectedLabel = PHASE_LABELS[phase];
  if (!expectedLabel) {
    return buildDecision('allow', `delivery-stage-label: unknown phase "${phase}"`);
  }

  if (declaredLabel === expectedLabel) {
    return buildDecision(
      'allow',
      `delivery-stage-label: label "${declaredLabel}" matches phase "${phase}"`,
      hookEventName || 'PostToolUse',
    );
  }

  // 警告（不阻断）：标签与实际阶段不符
  return {
    hookSpecificOutput: {
      hookEventName: hookEventName || 'PostToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: `delivery-stage-label: label "${declaredLabel}" != expected "${expectedLabel}" for phase "${phase}"`,
      additionalContext:
        `[交付门禁·警告] 阶段标签不一致：声明标签 \`${declaredLabel}\`，` +
        `但当前阶段 \`${phase}\` 应为 \`${expectedLabel}\`。` +
        `stage:X 标签应互斥推进（移旧加新），请核对 Issue 标签状态。`,
    },
    systemMessage: `[astra-hook delivery-stage-label] 标签 ${declaredLabel} 与阶段 ${phase}（应为 ${expectedLabel}）不符。这是警告不是阻断。`,
  };
}
