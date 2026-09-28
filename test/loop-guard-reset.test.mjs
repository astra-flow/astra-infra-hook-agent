/**
 * loop-guard-reset.test.mjs — 放行清计数 + 显式重置 + 误判链端到端（#1063 P2）
 *
 * 覆盖：
 *   1. AC-103：熔断/拦截放行后（成功 PostToolUse）streak/toolStreak/permissionFlag
 *      自动清零，下一次同类调用正常放行
 *   2. AC-104：bin/reset.mjs 显式重置 CLI（指定工具/全部）后计数清零
 *   3. AC-105：重置仅作用于当前会话（session 隔离）
 *   4. AC-106：误判链不复现——业务文本（正文含 403/permission denied）不再误判权限，
 *      读评论 → 终端回显 → 清理工具不再被拦的端到端模拟
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { run } from '../src/runtime.mjs';
import { readState, clearState } from '../src/lib/state.mjs';

const TEST_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-hook-reset-'));
process.env.ASTRA_HOOK_STATE_DIR = TEST_STATE;

const SESSION = 'reset-session';
const SESSION2 = 'reset-session-2';

test.beforeEach(() => {
  clearState('loop-guard', SESSION);
  clearState('loop-guard', SESSION2);
});

/** 构造 PreToolUse（同工具参数变异——指纹不触发，toolStreak 累积） */
const mkPre = (n) => JSON.stringify({
  sessionId: SESSION,
  toolName: 'edit_file',
  toolInput: { filePath: `/tmp/f${n}.txt`, newStr: `content-${n}`, editType: 'replace' },
  hookEventName: 'PreToolUse',
});

/** 构造同参数 PreToolUse（指纹触发） */
const mkSamePre = () => JSON.stringify({
  sessionId: SESSION,
  toolName: 'mcp_github_mcp_se_add_issue_comment',
  toolInput: { body: 'x', issue_number: 1, owner: 'o', repo: 'r' },
  hookEventName: 'PreToolUse',
});

/** 构造成功 PostToolUse（无权限类错误——放行证据） */
const mkPostSuccess = () => JSON.stringify({
  sessionId: SESSION,
  toolName: 'edit_file',
  toolResponse: '文件已成功更新',
  hookEventName: 'PostToolUse',
});

/** 构造含业务文本 403 的 PostToolUse（误判场景：读取的评论正文） */
const mkPostBizText = () => JSON.stringify({
  sessionId: SESSION,
  toolName: 'mcp_github_mcp_se_issue_read',
  toolResponse: '### 评论正文\n状态文件 {"permissionFlag":true} 是误判，error-classes.yaml 的裸 403 模式导致',
  hookEventName: 'PostToolUse',
});

// ---------- AC-103：放行清计数 ----------

test('R1: ask 熔断放行后成功 PostToolUse → streak/toolStreak 清零，下次调用正常', async () => {
  // 触发兜底 ask（同工具 12 次参数变异）
  let last;
  for (let i = 1; i <= 12; i++) {
    last = await run('loop-guard', mkPre(i), {});
  }
  assert.equal(last.hookSpecificOutput.permissionDecision, 'ask', '第 12 次触发兜底 ask');
  assert.ok(last.hookSpecificOutput.additionalContext || last.systemMessage);

  // 放行证据：该工具成功 PostToolUse
  const post = await run('loop-guard', mkPostSuccess(), {});
  assert.equal(post.hookSpecificOutput.permissionDecision, 'allow', 'PostToolUse 不阻断');

  // 状态验证：计数已清
  const state = await readState('loop-guard', SESSION);
  assert.equal(state.toolStreak, 0, 'toolStreak 已清');
  assert.equal(state.streak, 0, 'streak 已清');
  assert.equal(state.lastBlocked, null, 'lastBlocked 已清');

  // 下一次同类调用正常（新周期）
  const next = await run('loop-guard', mkPre(13), {});
  assert.equal(next.hookSpecificOutput.permissionDecision, 'allow', '放行后新周期正常调用');
});

test('R2: permissionFlag 放行后自动清除，同类工具恢复', async () => {
  // 先触发真实权限错误（强模式）
  const mkPostPerm = () => JSON.stringify({
    sessionId: SESSION,
    toolName: 'mcp_github_mcp_se_push_files',
    toolResponse: 'Error: 403 Forbidden',
    hookEventName: 'PostToolUse',
  });
  await run('loop-guard', mkPostPerm(), {});
  // 重试被拦
  const blocked = await run('loop-guard', JSON.stringify({
    sessionId: SESSION,
    toolName: 'mcp_github_mcp_se_push_files',
    toolInput: { files: [] },
    hookEventName: 'PreToolUse',
  }), {});
  assert.equal(blocked.hookSpecificOutput.permissionDecision, 'deny', '权限重试被拦');

  // 用户放行（改换参数后工具成功执行）→ PostToolUse 成功 → 清 permissionFlag
  const post = await run('loop-guard', JSON.stringify({
    sessionId: SESSION,
    toolName: 'mcp_github_mcp_se_push_files',
    toolResponse: '推送成功',
    hookEventName: 'PostToolUse',
  }), {});
  assert.equal(post.hookSpecificOutput.permissionDecision, 'allow');
  const state = await readState('loop-guard', SESSION);
  assert.equal(state.permissionFlag, false, 'permissionFlag 已清');
  assert.equal(state.permissionTool, null);

  // 恢复后同类调用放行
  const retry = await run('loop-guard', JSON.stringify({
    sessionId: SESSION,
    toolName: 'mcp_github_mcp_se_push_files',
    toolInput: { files: [{ path: 'x', content: 'y' }] },
    hookEventName: 'PreToolUse',
  }), {});
  assert.equal(retry.hookSpecificOutput.permissionDecision, 'allow', '放行后恢复可用');
});

test('R3: 正常连续调用不清计数（防循环利用）', async () => {
  // 无 lastBlocked 时正常调用不触发清计数
  await run('loop-guard', mkPre(1), {});
  await run('loop-guard', mkPostSuccess(), {});
  const state = await readState('loop-guard', SESSION);
  assert.equal(state.lastBlocked ?? null, null, '无拦截时 lastBlocked 应为 null');
  // 工具继续累积计数（从第 2 次开始）
  await run('loop-guard', mkPre(2), {});
  const s2 = await readState('loop-guard', SESSION);
  assert.equal(s2.toolStreak, 2, '正常连续调用计数继续累积');
});

// ---------- AC-106：误判链不复现（端到端） ----------

test('R4: 业务文本（评论正文含 403/permission denied）不置 permissionFlag——误判链第一环消除', async () => {
  const post = await run('loop-guard', mkPostBizText(), {});
  // 弱模式命中：不置位（PostToolUse 不产生权限错误提示）
  assert.equal(post.hookSpecificOutput.permissionDecision, 'allow');
  const state = await readState('loop-guard', SESSION);
  // 业务文本不置位：状态文件可能不存在（无任何写入）或 permissionFlag 为 false
  assert.ok(!state || state.permissionFlag !== true, '业务文本不置 permissionFlag');
  assert.ok(!state || state.permissionTool == null, 'permissionTool 未置');
});

test('R5: 误判链端到端——读评论 → 终端回显 → 清理工具均不再被拦', async () => {
  // 第一环：读取含关键词的评论（业务文本）→ 不置位
  await run('loop-guard', mkPostBizText(), {});
  // 第二环：终端回显状态（含 permissionFlag 字样）→ 不置位
  const mkTerminal = () => JSON.stringify({
    sessionId: SESSION,
    toolName: 'run_in_terminal',
    toolResponse: '{"permissionFlag":true,"permissionTool":"mcp_github_mcp_se_issue_read"}',
    hookEventName: 'PostToolUse',
  });
  await run('loop-guard', mkTerminal(), {});
  const state = await readState('loop-guard', SESSION);
  assert.ok(state?.permissionFlag !== true, '终端回显不置位');
  // 第三环：清理工具（read_file/其他）不再被拦
  const mkClean = () => JSON.stringify({
    sessionId: SESSION,
    toolName: 'read_file',
    toolInput: { filePath: '/tmp/x' },
    hookEventName: 'PreToolUse',
  });
  const clean = await run('loop-guard', mkClean(), {});
  assert.equal(clean.hookSpecificOutput.permissionDecision, 'allow', '清理工具不再被拦');
});

// ---------- AC-104/AC-105：显式重置 CLI ----------

test('R6: bin/reset.mjs 无参数重置当前会话全部计数', async () => {
  // 制造计数状态
  for (let i = 1; i <= 5; i++) await run('loop-guard', mkPre(i), {});
  let s = await readState('loop-guard', SESSION);
  assert.ok(s.toolStreak >= 5, '计数已累积');

  // 执行 reset CLI
  const binPath = path.resolve(process.cwd(), 'bin/reset.mjs');
  const out = execFileSync(process.execPath, [binPath, '--session', SESSION], { encoding: 'utf8' });
  assert.match(out, /已重置会话/, '输出确认');
  assert.match(out, /重置完成/, '完成确认');

  s = await readState('loop-guard', SESSION);
  assert.equal(s, null, '全部重置 = 状态文件清空');
});

test('R7: bin/reset.mjs --tool 仅重置指定工具', async () => {
  // edit_file 累积 5 次，另一工具累积 2 次
  for (let i = 1; i <= 5; i++) await run('loop-guard', mkPre(i), {});
  const mkOther = () => JSON.stringify({
    sessionId: SESSION,
    toolName: 'mcp_github_mcp_se_add_issue_comment',
    toolInput: { body: `b${Date.now()}`, issue_number: 1, owner: 'o', repo: 'r' },
    hookEventName: 'PreToolUse',
  });
  await run('loop-guard', mkOther(), {});
  await run('loop-guard', mkOther(), {});

  const binPath = path.resolve(process.cwd(), 'bin/reset.mjs');
  execFileSync(process.execPath, [binPath, '--session', SESSION, '--tool', 'edit_file'], { encoding: 'utf8' });

  const s = await readState('loop-guard', SESSION);
  assert.equal(s.toolStreak, 0, 'edit_file 相关计数清零');
  assert.equal(s.lastTool, 'mcp_github_mcp_se_add_issue_comment', '其他工具状态保留');
});

test('R8: 重置仅作用于当前会话（session 隔离，AC-105）', async () => {
  // 两个会话各自累积
  for (let i = 1; i <= 4; i++) await run('loop-guard', mkPre(i), {});
  const mkPre2 = () => JSON.stringify({
    sessionId: SESSION2,
    toolName: 'edit_file',
    toolInput: { filePath: '/tmp/g1.txt', newStr: 'g1', editType: 'replace' },
    hookEventName: 'PreToolUse',
  });
  await run('loop-guard', mkPre2(), {});
  await run('loop-guard', mkPre2(), {});

  const binPath = path.resolve(process.cwd(), 'bin/reset.mjs');
  execFileSync(process.execPath, [binPath, '--session', SESSION], { encoding: 'utf8' });

  const s1 = await readState('loop-guard', SESSION);
  assert.equal(s1, null, 'SESSION 已清空');
  const s2 = await readState('loop-guard', SESSION2);
  assert.ok(s2 && s2.toolStreak === 2, 'SESSION2 不受影响（隔离）');
});
