/**
 * normalize.mjs — 平台字段归一化（CP-04 平台适配层）
 *
 * 内部统一 camelCase 契约，hook 模块只读 camelCase 字段。
 * 输入来源：
 *   - VS Code：天然 camelCase（toolName / toolInput / sessionId / hookEventName）
 *   - Claude Code：snake_case（tool_name / tool_input / session_id / hook_event_name）
 *
 * 归一化策略：snake_case → camelCase 单向转换；已是 camelCase 的字段保留。
 */

const SNAKE_TO_CAMEL = {
  session_id: 'sessionId',
  tool_name: 'toolName',
  tool_input: 'toolInput',
  tool_response: 'toolResponse',
  hook_event_name: 'hookEventName',
  file_path: 'filePath',
  cwd: 'cwd',
  prompt: 'prompt',
  stop_hook_active: 'stopHookActive',
  source: 'source',
  trigger: 'trigger',
  // Claude Code 特有
  transcript_path: 'transcriptPath',
  permission_decision: 'permissionDecision',
};

/** snake_case → camelCase 通用转换（供未知字段兜底） */
function toCamel(str) {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * 归一化 hook 输入对象。
 * @param {object} raw - 原始输入
 * @returns {object} camelCase 契约对象（保留未知字段原样）
 */
export function normalizeInput(raw) {
  if (!raw || typeof raw !== 'object') return {};

  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const mapped = SNAKE_TO_CAMEL[key] || toCamel(key);
    // 深层归一化 tool_input / toolResponse 内部字段（file_path 等）
    if ((key === 'tool_input' || key === 'toolInput') && value && typeof value === 'object') {
      out[mapped] = normalizeNested(value);
    } else {
      out[mapped] = value;
    }
  }
  return out;
}

/** 归一化嵌套对象（工具参数内的 snake_case 字段） */
function normalizeNested(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    out[SNAKE_TO_CAMEL[key] || toCamel(key)] = value;
  }
  return out;
}
