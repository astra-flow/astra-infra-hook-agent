#!/usr/bin/env node
/**
 * astra-hook — Astra Flow Hook 工具统一可执行入口（平台能力层）
 *
 * 用法：
 *   astra-hook <hook-name> [--debug]
 *
 * VS Code `.github/hooks/*.json` command 指向本入口，例如：
 *   "command": "./infra/hook-agent/bin/astra-hook.mjs loop-guard"
 *
 * 本入口只做：解析子命令 → 读取 stdin JSON → 交给 runtime 分发 → 输出决策。
 * 任何异常一律 fail-open（exit 0 + continue），保证不误伤正常工具调用。
 */
import { run } from '../src/runtime.mjs';

// 从 stdin 读取完整输入（hooks 协议：事件 JSON 从 stdin 传入）
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

async function main() {
  const args = process.argv.slice(2);
  const hookName = args[0];
  const debug = args.includes('--debug');

  // 无 hook 名 → fail-open（不阻塞任何工具调用）
  if (!hookName || hookName.startsWith('-')) {
    if (debug) console.error('[astra-hook] missing hook name, fail-open');
    process.exit(0);
  }

  const stdin = await readStdin();
  const result = await run(hookName, stdin, { debug });

  // result 已保证是合法决策 JSON（fail-open 兜底），原样输出
  process.stdout.write(JSON.stringify(result));

  // 关键：使用 process.exitCode = 0 而非 process.exit(0)。
  // process.exit() 会强制终止事件循环，导致 decision-log 的 setImmediate 后台
  // 副作用（gh 评论）被丢弃，async 设计失效。exitCode 方式让事件循环自然退出，
  // execFile 回调（默认持有事件循环引用）能执行完。
  process.exitCode = 0;
}

main().catch(() => {
  // 顶层兜底：任何未捕获异常 → fail-open（continue）
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: '', permissionDecision: 'allow' } })
  );
  process.exit(0);
});
