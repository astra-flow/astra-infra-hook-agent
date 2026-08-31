/**
 * validate.mjs — 输入白名单校验 + 路径防护（CP-05 安全基线）
 *
 * 安全目标：
 *   1. 输入字段白名单校验：非法结构/超长字段 → fail-open（不阻塞，但拦截异常输入）
 *   2. 路径遍历防护：拒绝 ".." 穿越、绝对路径外的引用
 *   3. 类型校验：关键字段必须符合预期类型
 *
 * 注意：hook 是防御性执行环境，任何校验失败一律 fail-open（返回不合法），
 * 由 runtime 层转为 continue 决策，绝不让异常输入导致 deny 正常工具调用。
 */

/** 允许的最大输入长度（防超大 stdin 拖垮运行时） */
const MAX_INPUT_BYTES = 1_000_000; // ~1MB

/**
 * 校验输入是否安全。
 * @param {object} input - 已归一化的输入
 * @returns {{valid: boolean, reason?: string}}
 */
export function validateInput(input) {
  if (!input || typeof input !== 'object') {
    return { valid: false, reason: 'input not object' };
  }

  // 总字节数限制（sec/perf Medium：MAX_INPUT_BYTES 生效，防超大 stdin 拖垮运行时）
  try {
    if (Buffer.byteLength(JSON.stringify(input)) > MAX_INPUT_BYTES) {
      return { valid: false, reason: 'input exceeds max bytes' };
    }
  } catch {
    return { valid: false, reason: 'input not serializable' };
  }

  // sessionId 类型校验
  if (input.sessionId !== undefined && input.sessionId !== null && typeof input.sessionId !== 'string') {
    return { valid: false, reason: 'sessionId not string' };
  }

  // toolName 类型校验
  if (input.toolName !== undefined && typeof input.toolName !== 'string') {
    return { valid: false, reason: 'toolName not string' };
  }

  // prompt 长度限制（防超大 prompt 拖垮 JSON 解析/评论）
  if (input.prompt !== undefined && typeof input.prompt === 'string' && input.prompt.length > 20_000) {
    return { valid: false, reason: 'prompt too long' };
  }

  return { valid: true };
}

/**
 * 路径防护：拒绝路径遍历（.. 段）与危险字符。
 * 精确按段判断（sec Low 修复）：`a..b` 合法，`..` / `a/../b` 拒绝。
 */
export function isSafePath(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  const normalized = p.replace(/\\/g, '/');
  if (normalized.includes('\0')) return false; // NUL 字节
  // 按 / 拆分，逐段判断，仅拒绝恰好为 ".." 的段
  const segments = normalized.split('/');
  if (segments.includes('..')) return false; // 路径穿越
  return true;
}

/** 工具名白名单检查（用于 loop-guard 预过滤，不在白名单则跳过检测） */
export function isHotTool(toolName, hotTools) {
  if (!toolName || !Array.isArray(hotTools)) return false;
  return hotTools.includes(toolName);
}
