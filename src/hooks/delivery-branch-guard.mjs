/**
 * delivery-branch-guard.mjs — 交付门禁（阻断）：分支校验（#976）
 *
 * 规则：implement 阶段（ASTRA_SDLC_PHASE=implement）Agent 调用写工具时，
 * 当前 git 分支必须以 feature/ 或 hotfix/ 开头——否则 deny。
 * 分支纪律是红线：在 main/staging/production 直接改代码不可安全回退。
 *
 * 阶段声明契约：未声明 ASTRA_SDLC_PHASE → 放行（fail-open，不误伤常规编码）。
 * git 不可用（非 git 目录/命令失败）→ 放行（fail-open）。
 */
import { execFileSync } from 'node:child_process';
import { buildDeny, buildAllow } from '../lib/decision.mjs';

/** 写操作类工具（门禁拦截范围） */
const WRITE_TOOLS = new Set([
  'create_file', 'replace_string_in_file', 'multi_replace_string_in_file',
  'insert_edit_into_file', 'Write', 'Edit', 'NotebookEdit',
]);

/**
 * @param {object} input - 归一化输入（camelCase）
 * @param {object} meta - hook 元数据（allowedBranchPrefixes）
 */
export default async function deliveryBranchGuard(input, meta, { debug = false } = {}) {
  const { toolName, hookEventName } = input;

  if (!WRITE_TOOLS.has(toolName)) {
    return buildAllow('delivery-branch-guard: not a write tool');
  }

  // 阶段声明：仅 implement 阶段校验分支（specify/plan 等阶段 artifact 写入不涉及分支纪律）
  const phase = process.env.ASTRA_SDLC_PHASE || '';
  if (phase !== 'implement') {
    return buildAllow(`delivery-branch-guard: phase "${phase || 'none'}" not implement`);
  }

  // 当前分支检测（git 不可用 → fail-open；测试可注入 ASTRA_GIT_BRANCH 覆盖）
  let branch = '';
  if (process.env.ASTRA_GIT_BRANCH) {
    branch = process.env.ASTRA_GIT_BRANCH;
  } else {
    try {
      branch = execFileSync('git', ['branch', '--show-current'], {
        encoding: 'utf8', timeout: 3000, cwd: process.env.ASTRA_WORKSPACE_ROOT || process.cwd(),
      }).trim();
    } catch (err) {
      if (debug) console.error(`[delivery-branch-guard] git failed: ${err.message}`);
      return buildAllow('delivery-branch-guard: git unavailable (fail-open)');
    }
  }

  const prefixes = meta.allowedBranchPrefixes || ['feature/', 'hotfix/'];
  if (prefixes.some((p) => branch.startsWith(p))) {
    return buildAllow(`delivery-branch-guard: branch "${branch}" ok`, hookEventName || 'PreToolUse');
  }

  // 阻断：分支不合规
  return buildDeny(
    `[交付门禁·分支校验] 当前分支 \`${branch || '(detached)'}\` 不是交付分支。\n\n` +
    `- 规则：implement 阶段写代码必须在 \`${prefixes.join('/')}\` 分支上\n` +
    `- 纠偏：\`git flow feature start <描述>-issue-<N>\`（或 \`git checkout -b feature/...\`）后重试\n` +
    `- 禁止：在 main/staging/production 直接修改代码（不可安全回退）`,
    hookEventName || 'PreToolUse',
    `[astra-hook delivery-branch-guard] implement 阶段分支校验失败：当前在 ${branch || 'detached HEAD'}。` +
    `请先创建 feature/hotfix 分支。这不是故障，是交付门禁。`
  );
}
