/**
 * session-link.mjs — 会话↔Issue 关联的共享契约（#958 评审 Minor 6/7 修复）
 *
 * session-issue-link.mjs（写入方）与 decision-log.mjs（读取方）共享：
 *   - linkFile 路径解析（resolveLinkFile，消除重复实现）
 *   - 行格式契约（formatLinkLine / LINK_LINE_PATTERN，消除双处硬编码）
 *
 * 契约格式：`- <ts> | <event> | session=<id> | issue=#N`
 * 修改格式必须同步更新 LINK_LINE_PATTERN 与两侧调用方。
 */
import path from 'node:path';

/** 行格式契约：`- <ts> | <event> | session=<id> | issue=#N` */
export const LINK_LINE_PATTERN = /^- .+ \| .+ \| session=(\S+) \| issue=#(\d+)$/;

/**
 * 解析 linkFile 路径：支持绝对路径或相对工作区路径。
 * 相对路径以工作区根为基准（env ASTRA_WORKSPACE_ROOT 注入，避免硬编码）。
 * @param {string} linkFile - 配置的 linkFile 路径
 * @returns {string} 绝对路径
 */
export function resolveLinkFile(linkFile) {
  if (path.isAbsolute(linkFile)) return linkFile;
  const root = process.env.ASTRA_WORKSPACE_ROOT || process.cwd();
  return path.join(root, linkFile);
}

/**
 * 构造一条会话关联记录行（写入方使用）。
 * @param {string} timestamp - ISO 时间戳（已格式化为 `YYYY-MM-DD HH:mm:ss`）
 * @param {string} eventType - 事件类型（SessionStart / PostToolUse）
 * @param {string} safeSession - 已消毒的 sessionId（控制字符已替换）
 * @param {string} issueNum - Issue 编号（纯数字字符串）
 * @returns {string} 契约格式行（含尾部换行）
 */
export function formatLinkLine(timestamp, eventType, safeSession, issueNum) {
  return `- ${timestamp} | ${eventType} | session=${safeSession} | issue=#${issueNum}\n`;
}

/**
 * 从一行记录中提取 Issue 编号（读取方使用）。
 * @param {string} line - 契约格式行
 * @returns {string|null} Issue 编号字符串，格式不匹配返回 null
 */
export function parseLinkLine(line) {
  const m = LINK_LINE_PATTERN.exec(line.trim());
  return m ? m[2] : null;
}
