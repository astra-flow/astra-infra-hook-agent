/**
 * delivery-workitem-link.mjs — 交付门禁（警告）：work-item 关联校验（#976）
 *
 * 规则：specify 阶段产出 spec.md 后（PostToolUse），校验 spec.md 头部含
 * work-item ID（双向追溯锚点）——缺失则警告（不阻断，事后可补）。
 *
 * work-item ID 形态：`work-item: #N` / `work-item: N` / `Work-Item: #N`
 * （Astra preset 定制的 spec 头字段，intake 入口时由 extension 保证）。
 *
 * 阶段声明契约：ASTRA_SDLC_PHASE=specify 时生效；未声明 → 放行（fail-open）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildDecision } from '../lib/decision.mjs';

/** work-item ID 头字段匹配（行首注释或 YAML 头部） */
const WORKITEM_PATTERNS = [/work-item:\s*#?\d+/i, /workitem:\s*#?\d+/i];

/**
 * 扫描 specs/ 下最近的 feature 目录，检查 spec.md 头部 work-item ID。
 * @returns {{ok: boolean, reason: string}}
 */
function checkWorkItemLink(root) {
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
  const specFile = path.join(specsDir, dirs[0], 'spec.md');
  if (!fs.existsSync(specFile)) {
    return { ok: true, reason: `${dirs[0]}/spec.md 尚未产出（跳过）` };
  }
  // 只检查头部 30 行（work-item ID 是头字段）
  const head = fs.readFileSync(specFile, 'utf8').split('\n').slice(0, 30).join('\n');
  const hasLink = WORKITEM_PATTERNS.some((p) => p.test(head));
  if (!hasLink) {
    return { ok: false, reason: `${dirs[0]}/spec.md 头部缺少 work-item ID` };
  }
  return { ok: true, reason: `${dirs[0]}/spec.md work-item 关联存在` };
}

/**
 * @param {object} input - 归一化输入（camelCase）
 * @param {object} meta - hook 元数据
 */
export default async function deliveryWorkItemLink(input, meta, { debug = false } = {}) {
  const { hookEventName } = input;

  // 阶段声明：仅 specify 阶段校验
  const phase = process.env.ASTRA_SDLC_PHASE || '';
  if (phase !== 'specify') {
    return buildDecision('allow', `delivery-workitem-link: phase "${phase || 'none'}" not specify`);
  }

  const root = process.env.ASTRA_WORKSPACE_ROOT || process.cwd();
  let result;
  try {
    result = checkWorkItemLink(root);
  } catch (err) {
    if (debug) console.error(`[delivery-workitem-link] check failed: ${err.message}`);
    return buildDecision('allow', 'delivery-workitem-link: check failed (fail-open)');
  }

  if (result.ok) {
    return buildDecision('allow', `delivery-workitem-link: ${result.reason}`, hookEventName || 'PostToolUse');
  }

  // 警告（不阻断）
  return {
    hookSpecificOutput: {
      hookEventName: hookEventName || 'PostToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: `delivery-workitem-link: ${result.reason}`,
      additionalContext:
        `[交付门禁·警告] ${result.reason}。` +
        `spec.md 头部应含 work-item ID（如 "work-item: #976"）作为双向追溯锚点。` +
        `请补充关联后继续（intake 入口时由 extension 自动回写）。`,
    },
    systemMessage: `[astra-hook delivery-workitem-link] ${result.reason}。这是警告不是阻断，请补充 work-item 关联。`,
  };
}
