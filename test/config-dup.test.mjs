/**
 * config-dup.test.mjs — Hook 配置重复注册防护（Signal→eval 固化，#900 bug）
 *
 * 背景：2026-08-31 发现 decision-log 在 decision-log.json 与 session-issue-link.json
 * 中被重复注册（UserPromptSubmit），导致每次决策评论发布两条。
 * 本用例固化防护：解析 .github/hooks/*.json，断言同一事件下同一 hook 命令不重复。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 主仓 .github/hooks/ 目录（hook-agent 位于 infra/hook-agent，向上 3 级）
const HOOKS_DIR = path.resolve(__dirname, '../../../.github/hooks');

test('config: no duplicate hook registration across *.json (dup-comment bug)', () => {
  assert.ok(fs.existsSync(HOOKS_DIR), `.github/hooks not found at ${HOOKS_DIR}`);

  const files = fs.readdirSync(HOOKS_DIR).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0, 'no hook config json found');

  // 收集所有 (事件, command) 绑定
  const bindings = [];
  for (const f of files) {
    const cfg = JSON.parse(fs.readFileSync(path.join(HOOKS_DIR, f), 'utf8'));
    for (const [event, entries] of Object.entries(cfg.hooks || {})) {
      for (const entry of entries) {
        bindings.push({ file: f, event, command: entry.command });
      }
    }
  }

  // 断言：同一 (event, command) 只出现一次
  const seen = new Map();
  for (const b of bindings) {
    const key = `${b.event}::${b.command}`;
    const first = seen.get(key);
    assert.ok(!first, `duplicate hook registration: "${key}" in ${b.file} (also in ${first ? first.file : '?'})`);
    seen.set(key, b);
  }
});

test('config: decision-log registered exactly once for UserPromptSubmit', () => {
  const files = fs.readdirSync(HOOKS_DIR).filter((f) => f.endsWith('.json'));
  let count = 0;
  for (const f of files) {
    const cfg = JSON.parse(fs.readFileSync(path.join(HOOKS_DIR, f), 'utf8'));
    for (const entry of cfg.hooks?.UserPromptSubmit || []) {
      if (String(entry.command).includes('decision-log')) count += 1;
    }
  }
  assert.equal(count, 1, `decision-log should be registered exactly once for UserPromptSubmit, got ${count}`);
});
