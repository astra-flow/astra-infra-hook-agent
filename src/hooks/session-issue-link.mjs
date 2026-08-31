/**
 * session-issue-link.mjs — 会话↔Issue 关联记录（SessionStart + PostToolUse）
 *
 * 迁移自 .github/hooks/session-issue-link.sh，机制对齐：
 *   SessionStart：从分支名解析 Issue 编号（会话启动）
 *   PostToolUse：监听 issue_write 工具，从 tool_response 捕获新建 Issue 编号
 *   写入 memories/session/issue-link.md（追加，路径经 config 注入，非硬编码）
 *
 * 输出：continue（依赖副作用），任何失败 fail-open。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildAllow } from '../lib/decision.mjs';
import { isSafePath } from '../lib/validate.mjs';

/**
 * @param {object} input - 归一化输入（camelCase）
 * @param {object} meta - hook 元数据
 */
export default async function sessionIssueLink(input, meta, { debug = false } = {}) {
  const { hookEventName, sessionId, toolName, toolResponse } = input;
  if (!hookEventName) return buildAllow('session-issue-link: no event');

  let issueNum = '';
  let eventType = '';

  if (hookEventName === 'SessionStart') {
    // SessionStart：从分支名解析 Issue 编号
    issueNum = extractFromBranch();
    eventType = 'SessionStart';
  } else if (hookEventName === 'PostToolUse') {
    // PostToolUse：监听 issue_write 工具
    if (toolName === 'issue_write' || toolName === 'create_issue' || toolName === 'IssueWrite') {
      issueNum = extractFromResponse(toolResponse);
      eventType = 'PostToolUse';
    } else {
      return buildAllow('session-issue-link: not issue_write');
    }
  } else {
    return buildAllow('session-issue-link: event not applicable');
  }

  if (!issueNum) return buildAllow('session-issue-link: no issue number');

  // 写入会话关联文件（路径优先 env 注入，其次 config 注入；非硬编码 D8）
  const linkFile = process.env.ASTRA_SESSION_LINK_FILE || meta.linkFile;
  if (!linkFile || !isSafePath(linkFile)) return buildAllow('session-issue-link: unsafe link path');

  const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const line = `- ${timestamp} | ${eventType} | session=${sessionId || 'unknown'} | issue=#${issueNum}\n`;

  try {
    const absPath = resolveLinkFile(linkFile);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.appendFileSync(absPath, line, 'utf8');
  } catch (err) {
    if (debug) console.error(`[session-issue-link] write failed: ${err.message}`);
    return buildAllow('session-issue-link: write failed (fail-open)');
  }

  return buildAllow('session-issue-link: recorded');
}

/** 从分支名解析 Issue 编号（带 timeout，sec Low 修复） */
function extractFromBranch() {
  try {
    const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8', timeout: 3000 }).trim();
    const m = branch.match(/(\d+)$/);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

/** 从 tool_response 捕获 Issue 编号（优先 "id":"N"，其次 #N） */
function extractFromResponse(response) {
  if (!response) return '';
  const s = String(response);
  const m1 = s.match(/"id"\s*:\s*"(\d+)"/);
  if (m1) return m1[1];
  const m2 = s.match(/#(\d+)/);
  if (m2) return m2[1];
  return '';
}

/** 解析写入路径：支持相对工作区路径或绝对路径 */
function resolveLinkFile(linkFile) {
  if (path.isAbsolute(linkFile)) return linkFile;
  // 相对路径：以工作区根为基准（env ASTRA_WORKSPACE_ROOT 注入，避免硬编码）
  const root = process.env.ASTRA_WORKSPACE_ROOT || process.cwd();
  return path.join(root, linkFile);
}
