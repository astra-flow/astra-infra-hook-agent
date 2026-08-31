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
    // 高频易重复的工具白名单：仅对这些工具做指纹检测，降低无关调用开销
    hotTools: [
      'create_file', 'replace_string_in_file', 'multi_replace_string_in_file',
      'read_file', 'run_in_terminal', 'run_task',
      'Write', 'Edit', 'Read', 'Bash', 'NotebookEdit',
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
