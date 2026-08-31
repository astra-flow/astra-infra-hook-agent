/**
 * decision-log.mjs — UserPromptSubmit 评审决策自动评论（零 token 审计）
 *
 * 迁移自 .github/hooks/decision-log.sh，机制对齐：
 *   - 正则匹配决策关键词（正向 + 反向）
 *   - 命中 → 提取 Issue 编号（优先 prompt #N，其次分支名）
 *   - 调 gh issue comment 评论到 Issue
 *   - async（CP-03）：后台执行不阻塞；gh 缺失/解析失败 → fail-open
 *
 * 输出：UserPromptSubmit 仅通用输出（continue），本 hook 依赖副作用。
 */
import { execFile, execFileSync } from 'node:child_process';
import { buildAllow } from '../lib/decision.mjs';

/**
 * @param {object} input - 归一化输入（camelCase）
 * @param {object} meta - hook 元数据
 */
export default async function decisionLog(input, meta, { debug = false } = {}) {
  const prompt = input.prompt || '';
  if (!prompt) return buildAllow('decision-log: no prompt');

  // 决策分类
  const classification = classifyDecision(prompt, meta);
  if (!classification) return buildAllow('decision-log: no decision keyword');

  // 提取 Issue 编号：优先 prompt #N，其次 "issue N"，再次分支名
  const issueNum = extractIssueNumber(prompt);
  if (!issueNum) return buildAllow('decision-log: no issue number');

  // async 后台评论（CP-03），不 await 阻塞——但保证失败静默
  // 用 setImmediate 让调用方先返回决策
  setImmediate(() => {
    postComment(issueNum, classification, prompt, meta, { debug });
  });

  return buildAllow('decision-log: scheduled comment');
}

/** 决策分类：命中返回 {type,label}，未命中返回 null */
function classifyDecision(prompt, meta) {
  const pos = meta.positivePatterns || [];
  const neg = meta.negativePatterns || [];

  for (const p of pos) {
    if (new RegExp(p).test(prompt)) return { type: '正向决策', label: describePositive(p) };
  }
  for (const p of neg) {
    if (new RegExp(p).test(prompt)) return { type: '反向决策', label: describeNegative(p) };
  }
  return null;
}

function describePositive(p) {
  if (p.includes('确认合并')) return '确认合并';
  if (p.includes('Approved')) return 'Approved';
  return '同意/通过';
}

function describeNegative(p) {
  if (p.includes('重新设计')) return '需要修改/重新设计';
  if (p.includes('驳回') || p.includes('Rejected')) return '拒绝/驳回';
  if (p.includes('暂缓') || p.includes('clarification')) return '暂缓/待澄清';
  if (p.includes('不通过')) return '不通过';
  return '需要修改';
}

/** 提取 Issue 编号 */
function extractIssueNumber(prompt) {
  const m1 = prompt.match(/#(\d+)/);
  if (m1) return m1[1];
  const m2 = prompt.match(/issue\s*(\d+)/i);
  if (m2) return m2[1];
  // 分支名兜底
  try {
    const branch = execFileSyncSafe('git', ['branch', '--show-current']);
    const m3 = (branch || '').match(/(\d+)$/);
    if (m3) return m3[1];
  } catch { /* noop */ }
  return null;
}

/** 评论到 Issue（gh CLI，失败静默） */
function postComment(issueNum, classification, prompt, meta, { debug = false }) {
  const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const branch = execFileSyncSafe('git', ['branch', '--show-current']) || '未知';
  const sessionId = 'session'; // 运行时注入的 session 经 input 传入更佳

  const body =
    `**用户${classification.type}：${classification.label}**（${timestamp}）\n\n` +
    `> ${prompt.trim()}\n\n---\n` +
    `- 分支：\`${branch}\`\n` +
    `- 来源：UserPromptSubmit hook 自动记录（astra-hook decision-log）`;

  execFile('gh', ['issue', 'comment', issueNum, '--body', body], (err) => {
    if (debug && err) console.error(`[decision-log] gh comment failed: ${err.message}`);
  });
}

/** 安全执行命令并返回 stdout（失败返回 null） */
function execFileSyncSafe(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}
