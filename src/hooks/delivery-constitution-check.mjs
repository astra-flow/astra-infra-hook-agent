/**
 * delivery-constitution-check.mjs — 交付门禁（警告）：Constitution Check 校验（#976）
 *
 * 规则：plan 阶段产出 plan.md 后（PostToolUse），校验 plan.md 含
 * Constitution Check 节——缺失则警告（不阻断，文档规范问题可补）。
 *
 * 阶段声明契约：ASTRA_SDLC_PHASE=plan 时生效；未声明 → 放行（fail-open）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildDecision } from '../lib/decision.mjs';

const CONSTITUTION_SECTIONS = ['Constitution Check', '宪法检查'];

/**
 * 扫描 specs/ 下最近的 feature 目录，检查 plan.md 的 Constitution Check 节。
 * @returns {{ok: boolean, reason: string}}
 */
function checkConstitutionSection(root) {
  const specsDir = path.join(root, 'specs');
  if (!fs.existsSync(specsDir)) {
    return { ok: true, reason: 'specs/ 不存在（非 speckit 项目，跳过）' };
  }
  const dirs = fs.readdirSync(specsDir)
    .filter((d) => /^\d{3}-/.test(d))
    .sort()
    .reverse();
  if (dirs.length === 0) {
    return { ok: true, reason: 'specs/ 下无 feature 目录（跳过）' };
  }
  const planFile = path.join(specsDir, dirs[0], 'plan.md');
  if (!fs.existsSync(planFile)) {
    return { ok: true, reason: `${dirs[0]}/plan.md 尚未产出（跳过）` };
  }
  const content = fs.readFileSync(planFile, 'utf8');
  const hasSection = CONSTITUTION_SECTIONS.some((s) => content.includes(s));
  if (!hasSection) {
    return { ok: false, reason: `${dirs[0]}/plan.md 缺少 Constitution Check 节` };
  }
  return { ok: true, reason: `${dirs[0]}/plan.md Constitution Check 节存在` };
}

/**
 * @param {object} input - 归一化输入（camelCase）
 * @param {object} meta - hook 元数据
 */
export default async function deliveryConstitutionCheck(input, meta, { debug = false } = {}) {
  const { hookEventName } = input;

  // 阶段声明：仅 plan 阶段校验
  const phase = process.env.ASTRA_SDLC_PHASE || '';
  if (phase !== 'plan') {
    return buildDecision('allow', `delivery-constitution-check: phase "${phase || 'none'}" not plan`);
  }

  const root = process.env.ASTRA_WORKSPACE_ROOT || process.cwd();
  let result;
  try {
    result = checkConstitutionSection(root);
  } catch (err) {
    if (debug) console.error(`[delivery-constitution-check] check failed: ${err.message}`);
    return buildDecision('allow', 'delivery-constitution-check: check failed (fail-open)');
  }

  if (result.ok) {
    return buildDecision('allow', `delivery-constitution-check: ${result.reason}`, hookEventName || 'PostToolUse');
  }

  // 警告（不阻断）：additionalContext 注入纠偏提示
  return {
    hookSpecificOutput: {
      hookEventName: hookEventName || 'PostToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: `delivery-constitution-check: ${result.reason}`,
      additionalContext:
        `[交付门禁·警告] ${result.reason}。` +
        `plan.md 应包含 Constitution Check 节（对照 constitution.md 逐项检查方案，` +
        `违反不可妥协项 = Design Blocker）。请补充该节后继续。`,
    },
    systemMessage: `[astra-hook delivery-constitution-check] ${result.reason}。这是警告不是阻断，请补充 Constitution Check 节。`,
  };
}
