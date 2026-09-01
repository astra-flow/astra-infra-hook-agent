/**
 * config.mjs — Hook 元数据 schema 解析与校验（CP-02 结构化配置）
 *
 * 元数据单一来源：本文件内 HOOK_METADATA 表（hook 名 → 事件/超时/平台/依赖）。
 * 运行时通过 lib/config.mjs 读取；`.github/hooks/*.json` 仅存 VS Code 执行配置
 * （command 指向 bin/astra-hook.mjs <hook>），两者职责分离。
 */

/** hook 元数据 schema（平台能力层内部契约） */
export const HOOK_METADATA = {
  'loop-guard': {
    name: 'loop-guard',
    description: 'PreToolUse 重复执行检测（防死循环）',
    events: ['PreToolUse'],
    timeoutMs: 5000,
    platforms: ['vscode', 'claude-code'],
    // 豁免名单（exempt，2026-09-01 语义反转）：只读无害工具跳过指纹检测。
    // 旧 hotTools 白名单模式 = 默认放行未知工具，导致 MCP 工具（如
    // add_issue_comment）重复调用 60+ 次未被拦截（#899 占位评论事故）。
    // 新语义：默认监控所有工具（含 MCP），仅豁免明确只读的工具。
    exemptTools: [
      'read_file', 'Read', 'fetch_webpage', 'grep_search', 'list_dir',
      'file_search', 'view_image', 'copilot_getNotebookSummary',
      'read_notebook_cell_output', 'terminal_last_command', 'terminal_selection',
      'get_task_output', 'get_errors', 'read_page',
    ],
    threshold: 3, // 连续 N 次相同指纹触发拦截
    maxHistory: 50,
  },
  'decision-log': {
    name: 'decision-log',
    description: 'UserPromptSubmit 评审决策自动评论（零 token 审计）',
    events: ['UserPromptSubmit'],
    timeoutMs: 10000,
    platforms: ['vscode', 'claude-code'],
    async: true, // 重操作后台执行，不阻塞
    positivePatterns: ['确认合并', 'Decision:\\s*Approved', 'Approved', '同意', '通过', '确认'],
    negativePatterns: ['拒绝', '需要修改', '重新设计', '暂缓', '不通过', '驳回', 'Needs clarification', 'Rejected'],
  },
  'session-issue-link': {
    name: 'session-issue-link',
    description: '会话↔Issue 关联记录（SessionStart + PostToolUse）',
    events: ['SessionStart', 'PostToolUse'],
    timeoutMs: 5000,
    platforms: ['vscode', 'claude-code'],
    // 写入路径经配置注入（非硬编码，D8 路径防护）
    linkFile: process.env.ASTRA_SESSION_LINK_FILE || 'memories/session/issue-link.md',
  },
};

/**
 * 加载 hook 元数据。
 * @param {string} hookName
 * @returns {object|null} 元数据或 null（未知 hook）
 */
export function loadHookMetadata(hookName) {
  return HOOK_METADATA[hookName] || null;
}

/**
 * 校验 hook 元数据 schema（开发期自检）。
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateMetadataSchema() {
  const errors = [];
  for (const [name, meta] of Object.entries(HOOK_METADATA)) {
    if (!meta.events || !Array.isArray(meta.events) || meta.events.length === 0) {
      errors.push(`${name}: missing events`);
    }
    if (typeof meta.timeoutMs !== 'number') {
      errors.push(`${name}: missing timeoutMs`);
    }
    if (!meta.platforms || !Array.isArray(meta.platforms) || meta.platforms.length === 0) {
      errors.push(`${name}: missing platforms`);
    }
  }
  return { valid: errors.length === 0, errors };
}
