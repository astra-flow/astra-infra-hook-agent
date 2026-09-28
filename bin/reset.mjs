#!/usr/bin/env node
/**
 * reset.mjs — loop-guard 计数器显式重置 CLI（#1063 P2，补 US6/FR-010）
 *
 * 用途：用户/Agent 在误拦或熔断放行后，通过显式指令重置计数器，恢复工具可用性。
 *       #1020 US6/FR-010 原 spec 未实现（D1 偏差）——本入口补齐"显式重置逃生口"。
 *
 * 用法：
 *   node bin/reset.mjs                  # 重置当前会话全部计数
 *   node bin/reset.mjs --tool <name>    # 仅重置指定工具的计数
 *   node bin/reset.mjs --session <id>   # 重置指定会话（默认：当前/全部会话）
 *
 * 设计：
 *   - 零依赖（D1 铁律）：仅复用 src/lib/state.mjs 的 readState/updateState/clearState
 *   - fail-open：任何异常输出错误信息但 exit 0（CLI 不阻塞后续动作）
 *   - 会话隔离：--session 显式指定；默认重置全部会话（运维场景）或当前会话（由环境推断）
 *   - 输出确认：明确展示重置了哪个会话/哪些计数，供审计
 */
import { readState, updateState, clearState, stateRoot } from '../src/lib/state.mjs';
import fs from 'node:fs';
import path from 'node:path';

const LOOP_GUARD = 'loop-guard';

/** 解析 CLI 参数：--tool <name> / --session <id> / --all */
function parseArgs(argv) {
  const opts = { tool: null, session: null, all: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tool' && argv[i + 1]) {
      opts.tool = argv[i + 1];
      i++;
    } else if (arg === '--session' && argv[i + 1]) {
      opts.session = argv[i + 1];
      i++;
    } else if (arg === '--all') {
      opts.all = true;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    }
  }
  return opts;
}

/** 列出当前所有会话状态文件（sessionId → 路径） */
function listSessions() {
  const root = stateRoot();
  const dir = path.join(root, LOOP_GUARD);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ sessionId: f.replace(/\.json$/, ''), file: path.join(dir, f) }));
}

/**
 * 重置指定会话的计数。
 * - tool 为 null：清空该会话全部状态（clearState 删除状态文件 = 全新周期）
 * - tool 指定：仅清该工具相关计数（toolStreak/lastBlocked/permissionFlag 若指向该工具）
 * @returns {string[]} 已重置字段描述（输出确认用）
 */
async function resetSession(sessionId, tool) {
  if (!tool) {
    clearState(LOOP_GUARD, sessionId);
    return ['全部计数（状态文件已清空）'];
  }
  const state = await readState(LOOP_GUARD, sessionId);
  if (!state) return ['（无状态）'];
  const cleared = [];
  await updateState(LOOP_GUARD, sessionId, (prev) => {
    if (!prev) return prev;
    const next = { ...prev };
    if (typeof prev.toolStreak === 'number') {
      next.toolStreak = 0;
      cleared.push(`toolStreak(${prev.toolStreak}→0)`);
    }
    if (typeof prev.streak === 'number' && prev.lastTool === tool) {
      next.streak = 0;
      cleared.push(`streak(${prev.streak}→0)`);
    }
    if (prev.lastBlocked && prev.lastBlocked.tool === tool) {
      next.lastBlocked = null;
      cleared.push('lastBlocked');
    }
    if (prev.permissionFlag && prev.permissionTool === tool) {
      next.permissionFlag = false;
      next.permissionTool = null;
      cleared.push('permissionFlag');
    }
    next.updatedAt = Date.now();
    return next;
  });
  return cleared;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      '用法：node bin/reset.mjs [--tool <name>] [--session <id>] [--all]\n' +
      '  （无参数）重置当前会话全部计数\n' +
      '  --tool <name>   仅重置指定工具相关计数\n' +
      '  --session <id>  重置指定会话（可用 --all 重置全部会话）\n' +
      '  --all           重置全部会话'
    );
    return;
  }

  const sessions = listSessions();
  // 会话选择：--session 显式 > --all 全部 > 默认全部（CLI 无当前会话上下文，全部最安全）
  const targets = opts.all || (!opts.session && sessions.length <= 1)
    ? sessions
    : sessions.filter((s) => s.sessionId === opts.session);

  if (targets.length === 0) {
    console.log('loop-guard: 无会话状态需要重置（状态目录为空或不存在）');
    return;
  }

  for (const { sessionId } of targets) {
    const cleared = await resetSession(sessionId, opts.tool);
    console.log(`loop-guard: 已重置会话 ${sessionId} → ${cleared.join(', ') || '（无相关计数）'}`);
  }
  console.log('loop-guard: 重置完成。计数器已清零，工具恢复可用（苗头/熔断阈值仍生效）。');
}

main().catch((err) => {
  console.error(`loop-guard reset error: ${err.message || err}`);
  process.exitCode = 0; // fail-open：CLI 异常不阻塞后续动作
});
