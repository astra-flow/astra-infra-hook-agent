/**
 * state.mjs — 状态存储（CP-01/D4：~/.astra/hooks/ + 原子写 + 轻量文件锁）
 *
 * 从 /tmp/copilot-loop-guard/ 迁移到用户目录 ~/.astra/hooks/<name>/<sessionId>.json，
 * 跨平台一致、持久、避免系统临时目录差异。
 *
 * 并发安全（D6）：读-改-写用轻量文件锁（mkdirSync recursive + retry），
 * 避免 VS Code 并发触发同 session 多个 hook 调用时的写竞态。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 状态根目录（可被 env 覆盖，便于测试） */
const STATE_ROOT = process.env.ASTRA_HOOK_STATE_DIR
  ? path.resolve(process.env.ASTRA_HOOK_STATE_DIR)
  : path.join(os.homedir(), '.astra', 'hooks');

/** 状态文件命名：<name>/<sessionId>.json */
function stateFilePath(name, sessionId) {
  return path.join(STATE_ROOT, name, `${sanitizeId(sessionId)}.json`);
}

/** 会话 ID 消毒：只保留安全字符，防止路径穿越 */
function sanitizeId(id) {
  if (!id) return 'default';
  return String(id).replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** 轻量文件锁：基于 mkdir atomicity + retry */
async function withLock(lockDir, fn, { timeoutMs = 1000, retryIntervalMs = 10 } = {}) {
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lockDir, { recursive: false });
      break;
    } catch {
      if (Date.now() - start > timeoutMs) {
        // 锁超时：不阻塞主流程（fail-open），直接执行（接受极小概率竞态）
        try { fs.rmdirSync(lockDir, { recursive: true }); } catch { /* noop */ }
        return fn();
      }
      await new Promise((r) => setTimeout(r, retryIntervalMs));
    }
  }
  try {
    return await fn();
  } finally {
    try { fs.rmdirSync(lockDir, { recursive: true }); } catch { /* noop */ }
  }
}

/**
 * 读取状态（不存在返回 null）。
 * @param {string} name - hook 名
 * @param {string} sessionId
 * @returns {Promise<object|null>}
 */
export async function readState(name, sessionId) {
  try {
    const raw = fs.readFileSync(stateFilePath(name, sessionId), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 原子读-改-写（带文件锁）。
 * @param {string} name - hook 名
 * @param {string} sessionId
 * @param {(prev: object|null) => object|null} mutate - 返回 null 表示不写
 * @returns {Promise<object|null>} 写入后的状态
 */
export async function updateState(name, sessionId, mutate) {
  const file = stateFilePath(name, sessionId);
  const lockDir = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  return withLock(lockDir, async () => {
    const prev = await readState(name, sessionId);
    const next = mutate(prev);
    if (next === null) return prev;
    // 原子写：tmp + rename
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(next), 'utf8');
    fs.renameSync(tmp, file);
    return next;
  });
}

/** 重置状态（测试/清理用） */
export function clearState(name, sessionId) {
  try {
    fs.rmSync(stateFilePath(name, sessionId), { force: true });
  } catch { /* noop */ }
}

export { STATE_ROOT };
