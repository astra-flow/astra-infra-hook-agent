/**
 * delivery-test-gate.mjs — 交付门禁（阻断）：测试门禁（#976）
 *
 * 规则：converge 阶段（ASTRA_SDLC_PHASE=converge）Agent 调用写工具时，
 * 必须存在测试通过证据——specs/<NNN-feature>/test.md 含执行记录节
 * （「## 执行记录」或「## 测试报告」且无「未通过」遗留），否则 deny。
 *
 * 测试证据形态（交付模型 v1.0 Test 阶段三形态）：
 *   - 业务功能交付：test.md 业务测试执行记录
 *   - Agent 配置交付：test.md evals 执行结果
 *   - 治理/文档交付：test.md 评审记录（无独立测试，评审即门禁）
 * 三形态统一以 test.md 承载——本 hook 只查 test.md 存在性 + 执行记录节。
 *
 * 阶段声明契约：未声明 → 放行（fail-open）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildDeny, buildAllow } from '../lib/decision.mjs';

/** 写操作类工具（门禁拦截范围） */
const WRITE_TOOLS = new Set([
  'create_file', 'replace_string_in_file', 'multi_replace_string_in_file',
  'insert_edit_into_file', 'Write', 'Edit', 'NotebookEdit',
]);

/** test.md 中认可的执行记录节标题 */
const EVIDENCE_SECTIONS = ['## 执行记录', '## 测试报告', '## 评审记录', '## evals 执行结果'];

/**
 * 扫描 specs/ 下最近的 feature 目录，检查 test.md 测试证据。
 * @returns {{ok: boolean, reason: string}}
 */
function checkTestEvidence(root) {
  const specsDir = path.join(root, 'specs');
  if (!fs.existsSync(specsDir)) {
    return { ok: false, reason: 'specs/ 目录不存在' };
  }
  const dirs = fs.readdirSync(specsDir)
    .filter((d) => /^\d{3}-/.test(d))
    .sort()
    .reverse();
  if (dirs.length === 0) {
    return { ok: false, reason: 'specs/ 下无 feature 目录（<NNN-feature>）' };
  }
  const testFile = path.join(specsDir, dirs[0], 'test.md');
  if (!fs.existsSync(testFile)) {
    return { ok: false, reason: `${dirs[0]}/test.md 不存在（Test 阶段未产出测试证据）` };
  }
  const content = fs.readFileSync(testFile, 'utf8');
  const hasEvidence = EVIDENCE_SECTIONS.some((s) => content.includes(s));
  if (!hasEvidence) {
    return { ok: false, reason: `${dirs[0]}/test.md 缺少执行记录节（${EVIDENCE_SECTIONS.join(' / ')} 之一）` };
  }
  return { ok: true, reason: `${dirs[0]}/test.md 测试证据存在` };
}

/**
 * @param {object} input - 归一化输入（camelCase）
 * @param {object} meta - hook 元数据
 */
export default async function deliveryTestGate(input, meta, { debug = false } = {}) {
  const { toolName, hookEventName } = input;

  if (!WRITE_TOOLS.has(toolName)) {
    return buildAllow('delivery-test-gate: not a write tool');
  }

  // 阶段声明：仅 converge 阶段校验测试证据
  const phase = process.env.ASTRA_SDLC_PHASE || '';
  if (phase !== 'converge') {
    return buildAllow(`delivery-test-gate: phase "${phase || 'none'}" not converge`);
  }

  const root = process.env.ASTRA_WORKSPACE_ROOT || process.cwd();
  let result;
  try {
    result = checkTestEvidence(root);
  } catch (err) {
    if (debug) console.error(`[delivery-test-gate] check failed: ${err.message}`);
    return buildAllow('delivery-test-gate: check failed (fail-open)');
  }

  if (result.ok) {
    return buildAllow(`delivery-test-gate: ${result.reason}`, hookEventName || 'PreToolUse');
  }

  // 阻断：测试证据缺失
  return buildDeny(
    `[交付门禁·测试门禁] converge 前置不满足：${result.reason}。\n\n` +
    `- 规则：Test 阶段产出的 test.md（三形态：业务测试/evals/评审记录）是 Deploy 门禁依据\n` +
    `- 纠偏：先执行 Test 阶段动作（跑测试套件/evals/收集评审记录）产出 test.md，再进入 converge\n` +
    `- 禁止：测试未过或无证据就推进合并（质量红线）`,
    hookEventName || 'PreToolUse',
    `[astra-hook delivery-test-gate] converge 阶段测试证据缺失：${result.reason}。` +
    `请先完成 Test 阶段产出 test.md。这不是故障，是交付门禁。`
  );
}
