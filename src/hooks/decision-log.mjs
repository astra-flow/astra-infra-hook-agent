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
 *
 * #958 修复（2026-09-07，全量审计 19 Issue/87 条评论确认四类缺陷）：
 *   - AC1 极性正确：否定语义优先判定（"不同意"不再命中"同意"）；
 *     疑问句（？/? 结尾或含吗/么/呢）不触发决策记录
 *   - AC2 来源标注：子代理任务书（"你是XX"开头）与 Agent 生成消息
 *     （"Analysis approved by user"等）不记录
 *   - AC3 去重：同 Issue + 同内容（归一化后）120s 窗口内不重复发布
 *   - AC4 归属可信：分支兜底来源的评论显著标注"可能串 Issue"
 */
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { buildAllow } from '../lib/decision.mjs';
import { updateState } from '../lib/state.mjs';
import { parseLinkLine, resolveLinkFile } from '../lib/session-link.mjs';

/** 去重窗口（毫秒）：同 Issue + 同内容在此窗口内不重复发布 */
export const DEDUP_WINDOW_MS = 120_000;

/**
 * P2：从 session-issue-link 记录解析当前会话关联的 Issue 编号。
 *
 * session-issue-link hook 在 SessionStart/PostToolUse(issue_write) 时追加记录到
 * linkFile（格式：`- <ts> | <event> | session=<id> | issue=#N`）。
 * 本函数取该 sessionId 的**最后一条**记录作为会话关联 Issue。
 *
 * 优先级：prompt 显式 #N > 会话关联 > 分支名兜底（#953 事故根因降级为末位）。
 *
 * @param {string} sessionId - 当前会话 ID
 * @param {object} meta - hook 元数据（含 linkFile 配置）
 * @returns {string|null} Issue 编号字符串，无关联返回 null
 */
export function resolveFromSessionLink(sessionId, meta) {
  try {
    const linkFile = process.env.ASTRA_SESSION_LINK_FILE || meta.linkFile;
    if (!linkFile) return null;
    // 路径解析复用共享契约库（#958 评审 Minor 6：消除重复实现）
    const absPath = resolveLinkFile(linkFile);
    const raw = fs.readFileSync(absPath, 'utf8');
    const safeSession = String(sessionId || '').replace(/[\r\n\u0000-\u001F]/g, '_');
    const lines = raw.split('\n').filter((l) => l.includes(`session=${safeSession} | issue=#`));
    if (lines.length === 0) return null;
    // 行解析复用共享契约库（Minor 7：格式契约单一来源）
    return parseLinkLine(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

/**
 * @param {object} input - 归一化输入（camelCase）
 * @param {object} meta - hook 元数据
 */
export default async function decisionLog(input, meta, { debug = false } = {}) {
  const prompt = input.prompt || '';
  if (!prompt) return buildAllow('decision-log: no prompt');

  // AC2 来源过滤：非用户决策不记录（子代理任务书 / Agent 生成消息）
  const source = classifySource(prompt);
  if (source === 'agent-generated') {
    return buildAllow('decision-log: agent-generated prompt, skip');
  }

  // AC1 极性判定：先排除疑问句，再做关键词分类
  if (isInterrogative(prompt)) {
    return buildAllow('decision-log: interrogative prompt, skip');
  }

  const classification = classifyDecision(prompt, meta);
  if (!classification) return buildAllow('decision-log: no decision keyword');

  // 提取 Issue 编号（P2 优先级链）：prompt 显式 #N > 会话关联（session-issue-link）> 分支名兜底
  // 同步部分仅纯字符串正则；会话关联读文件与 git 分支名兜底移入后台（perf Medium 修复）
  const issueNum = extractIssueNumberSync(prompt);
  if (!issueNum) {
    // 无编号 → 后台解析会话关联/分支名兜底；主流程先返回（避免同步 IO 阻塞）
    const sessionId = input.sessionId || '';
    setImmediate(() => {
      // P2：优先会话关联（多会话共享 worktree 下比分支名可信）
      let num = resolveFromSessionLink(sessionId, meta);
      let by = 'session-link';
      if (!num) {
        num = extractFromBranch();
        by = 'branch';
      }
      if (num) {
        // Blocking 3（P-M1）：后台链路 rejection 兑底，维持 fail-open 契约
        // （updateState IO 异常不再导致 unhandled rejection 进程非零退出）
        postComment(num, classification, prompt, meta, { debug, resolvedBy: by, source, sessionId })
          .catch((err) => {
            if (debug) console.error(`[decision-log] background resolve failed: ${err.message}`);
          });
      }
    });
    return buildAllow('decision-log: scheduled session-resolve');
  }

  // async 后台评论（CP-03）：setImmediate 让调用方先返回决策；
  // bin 入口用 process.exitCode=0（非 exit()），事件循环会等回调执行完（async 失效修复）
  setImmediate(() => {
    // Blocking 3（P-M1）：同上，后台链路 rejection 兑底
    postComment(issueNum, classification, prompt, meta, { debug, resolvedBy: 'prompt', source, sessionId: input.sessionId || '' })
      .catch((err) => {
        if (debug) console.error(`[decision-log] background comment failed: ${err.message}`);
      });
  });

  return buildAllow('decision-log: scheduled comment');
}

/** 正则缓存（perf Low：避免每次调用 new RegExp） */
const patternCache = new Map();

function compilePattern(p) {
  let re = patternCache.get(p);
  if (!re) {
    re = new RegExp(p);
    patternCache.set(p, re);
  }
  return re;
}

/** 决策分类：命中返回 {type,label}，未命中返回 null */
function classifyDecision(prompt, meta) {
  const pos = meta.positivePatterns || [];
  const neg = meta.negativePatterns || [];

  // AC1 否定语义优先：反向模式先于正向匹配。
  // "不同意"包含"同意"——必须先检查否定形态，防止极性反转（#949 04:11:54 事故）。
  for (const p of neg) {
    if (compilePattern(p).test(prompt)) return { type: '反向决策', label: describeNegative(p) };
  }
  // 否定前缀 + 正向词 → 非决策（语义已否定，如"不同意把OAuth放到efficiency下面"）
  if (/(不同意|不通过|不批准|不认可|不支持)/.test(prompt)) {
    return null;
  }
  for (const p of pos) {
    if (compilePattern(p).test(prompt)) return { type: '正向决策', label: describePositive(p) };
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

/** 提取 Issue 编号：仅纯字符串正则（同步，无 git）。
 * Minor 3（M3）：返回全部候选编号，多 #N 时由调用方降级处理，防错误归属。 */
function extractIssueNumbersSync(prompt) {
  const nums = [];
  for (const m of prompt.matchAll(/#(\d+)/g)) nums.push(m[1]);
  if (nums.length === 0) {
    const m2 = prompt.match(/issue\s*(\d+)/i);
    if (m2) nums.push(m2[1]);
  }
  return nums;
}

/** 提取 Issue 编号（兼容旧接口）：首个候选；多候选时返回 null（由调用方降级） */
function extractIssueNumberSync(prompt) {
  const nums = extractIssueNumbersSync(prompt);
  if (nums.length === 0) return null;
  if (nums.length === 1) return nums[0];
  // 多个不同编号：首个匹配即归属有错误风险（"参考 #953 的评论，同意此方案"）
  // → 返回 null，走会话关联/分支兜底并在评论体标注（Minor 3）
  const unique = new Set(nums);
  return unique.size === 1 ? nums[0] : null;
}

/** 从分支名解析 Issue 编号（后台调用，带 timeout） */
function extractFromBranch() {
  try {
    const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8', timeout: 3000 }).trim();
    const m = (branch || '').match(/(\d+)$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** prompt 脱敏（sec Medium）：截断 + 去链接/@ + 敏感键值隐藏 + 防 Markdown 注入。
 * Blocking 2（Sec-H2）：压为单行 + 转义 Markdown 结构字符，防伪造归属标注行。 */
function sanitizePrompt(prompt) {
  let s = String(prompt || '').trim();
  if (s.length > 500) s = `${s.slice(0, 500)}…(截断)`;
  // 去 @ 提人（防社交工程）
  s = s.replace(/@[\w.-]+/g, '@***');
  // 去 URL（防外链注入）
  s = s.replace(/https?:\/\/[^\s]+/g, '[link]');
  // 隐藏常见敏感模式（key/token 等）
  s = s.replace(/(key|token|password|secret|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=***');
  // 隐藏无标签裸 token（Minor 1/M1：ghp_/github_pat_/sk-/Bearer/AKIA/xoxb 形态）
  s = s.replace(/\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, '[token]');
  s = s.replace(/\bBearer\s+[A-Za-z0-9._-]{20,}/gi, 'Bearer ***');
  // Blocking 2（Sec-H2）：压为单行（换行转空格），prompt 内容不再跨行注入评论体
  s = s.replace(/\s+/g, ' ');
  // 转义 Markdown 结构字符：行首分隔线/列表/引用/代码围栏不再可伪造
  s = s.replace(/^(-{3,}|\*{3,}|_{3,})$/, '—');
  s = s.replace(/^\s*([-*+]|\d+\.)\s/, '· ');
  s = s.replace(/^\s*>\s?/, '&gt; ');
  s = s.replace(/`/g, "'");
  // 控制字符清理（保留空格，已在上方归一）
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  return s;
}

/**
 * AC2 来源分类：区分用户输入与 Agent 生成内容。
 * - 子代理任务书：以"你是"开头的角色指派（"你是性能评审子代理…"）
 * - Agent 生成消息：Agent 自行宣布的决策/状态（"Analysis approved by user"等）
 * 返回 'user' | 'agent-generated'
 */
export function classifySource(prompt) {
  const s = String(prompt || '').trim();
  // 子代理任务书：开头即角色指派
  if (/^你是/.test(s)) return 'agent-generated';
  // Agent 生成消息：固定模板短语（Agent 宣布决策，非用户输入）
  if (/^(Analysis approved by user|Architecture design approved by user|Design rejected or needs revision)/.test(s)) {
    return 'agent-generated';
  }
  return 'user';
}

/**
 * AC1 疑问句过滤：以？/? 结尾，或疑问语气词（吗/么/呢）后接问号。
 * 疑问句是澄清/确认请求，不是决策（"评审通过了么？"、"你确认正常吗？"）。
 * Minor 8：语气词后限定扫描窗口（200 字符），避免长 prompt 贪婪回溯。
 */
export function isInterrogative(prompt) {
  const s = String(prompt || '').trim();
  if (/[？?]\s*$/.test(s)) return true;
  // 句中疑问语气词 + 有限窗口内问号（多句 prompt 中疑问子句主导语义）
  if (/[吗么呢][^。！!？?]{0,200}[？?]/.test(s)) return true;
  return false;
}

/** 评论内容归一化（AC3 去重键）：去除全部空白差异，保留语义 */
function normalizeForDedup(prompt) {
  return String(prompt || '').trim().replace(/\s+/g, '');
}

/**
 * AC3 去重检查：同 Issue + 同内容（归一化）在 DEDUP_WINDOW_MS 内已发布 → true。
 * 状态存 <stateRoot>/decision-log-dedup/<sessionId>.json（复用 state.mjs 原子写）。
 * Minor 2（M2）：检查移入 updateState mutate 闭包内（锁内读-判-写），消除 TOCTOU
 * 与冗余读；键哈希化（Minor 5/L1），状态文件不存明文 prompt。
 */
export async function isDuplicate(sessionId, issueNum, prompt, { now = Date.now() } = {}) {
  const key = `${issueNum}:${dedupKeyHash(prompt)}`;
  let duplicate = false;
  await updateState('decision-log-dedup', sessionId, (prev) => {
    const history = (prev && Array.isArray(prev.entries)) ? prev.entries : [];
    if (history.some((e) => e.key === key && now - e.at < DEDUP_WINDOW_MS)) {
      duplicate = true;
      return prev; // 重复：不写入新记录，保持状态不变
    }
    // 滑动清理：只保留窗口内的记录，防状态膨胀
    const entries = history.filter((e) => now - e.at < DEDUP_WINDOW_MS);
    entries.push({ key, at: now });
    return { entries };
  });
  return duplicate;
}

/** 去重键哈希（Minor 5/L1）：状态文件不存明文 prompt */
function dedupKeyHash(prompt) {
  return createHash('sha1').update(normalizeForDedup(prompt)).digest('hex').slice(0, 16);
}

/**
 * 评论到 Issue（gh CLI，失败静默；execFile 带 timeout）。
 * @param {string} resolvedBy - Issue 编号来源：'prompt' | 'session-link' | 'branch'
 * @param {string} sessionId - 真实会话 ID（Blocking 1：去重按会话隔离，
 *   多会话共享 worktree 下不再互相抑制合法审计记录）
 */
async function postComment(issueNum, classification, prompt, meta, { debug = false, resolvedBy = 'prompt', source = 'user', sessionId = '' } = {}) {
  // AC3 去重前置（perf Minor 6）：去重命中时省一次 git spawn
  const sid = sessionId || 'default';
  if (await isDuplicate(sid, issueNum, prompt)) {
    if (debug) console.error('[decision-log] duplicate comment suppressed (dedup window)');
    return;
  }

  const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const branch = extractFromBranch() || '未知';

  // AC4 归属可信标注：非 prompt 来源在多会话共享 worktree 下可能串 Issue
  // （#953 事故：#944 会话的决策因分支被切到 feature/sot-subscription-953 而误发）
  // P2：session-link 来源可信度高于 branch，但仍非显式声明，保留提示
  const attributionNote = resolvedBy === 'branch'
    ? '\n- ⚠️ **归属来源：分支名兜底**——多会话共享工作区时分支可能不代表本会话工作 Issue，此评论归属需人工复核'
    : resolvedBy === 'session-link'
      ? '\n- ℹ️ **归属来源：会话关联**（session-issue-link 记录）——非 prompt 显式声明，如归属有误请反馈至 #958'
      : '';
  const sourceNote = source === 'agent-generated' ? '（agent-generated）' : '';

  const body =
    `**用户${classification.type}：${classification.label}**${sourceNote}（${timestamp}）\n\n` +
    `> ${sanitizePrompt(prompt)}\n\n---\n` +
    `- 分支：\`${branch}\`\n` +
    `- Issue 归属来源：${resolvedBy === 'branch' ? '分支名兜底' : resolvedBy === 'session-link' ? '会话关联' : 'prompt 提取'}${attributionNote}\n` +
    `- 来源：UserPromptSubmit hook 自动记录（astra-hook decision-log）`;

  const child = execFile('gh', ['issue', 'comment', issueNum, '--body', body], { timeout: 10000 }, (err) => {
    // Minor 4（M4）：审计失败始终 stderr 记录（不依赖 --debug），审计缺口可见
    if (err) console.error(`[decision-log] gh comment failed for #${issueNum}: ${err.message}`);
  });
  // 避免超时后子进程残留
  if (child) child.on('error', () => { /* fail-open */ });
}
