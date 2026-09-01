/**
 * delivery-gate.test.mjs — 交付门禁 evals（#915：SDLC artifact 存在性）
 *
 * 覆盖：
 *   1. design 阶段 + spec.md 缺失 → deny + 纠偏指引（含 /analyze 恢复路径）
 *   2. design 阶段 + spec.md 存在 → allow
 *   3. implement 阶段 + task-breakdown 缺失 → deny
 *   4. 未声明阶段 → 放行（fail-open，不误伤常规编码）
 *   5. 读工具 → 放行（检查 artifact 需要读）
 *   6. 未知阶段 → 放行
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/runtime.mjs';

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-gate-'));
process.env.ASTRA_WORKSPACE_ROOT = TEST_ROOT;

const SESSION = 'gate-test-session';

const writeTool = (toolName = 'create_file') => JSON.stringify({
  sessionId: SESSION,
  toolName,
  toolInput: { filePath: '/tmp/x.ts', content: 'code' },
  hookEventName: 'PreToolUse',
});

test('GATE: design phase + spec.md missing → deny with /analyze guidance', async () => {
  process.env.ASTRA_SDLC_PHASE = 'design';
  const r = await run('delivery-gate', writeTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /spec\.md/);
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /\/analyze/);
  assert.ok(r.systemMessage, 'deny must include systemMessage');
  assert.match(r.systemMessage, /交付门禁/);
});

test('GATE: design phase + spec.md present → allow', async () => {
  process.env.ASTRA_SDLC_PHASE = 'design';
  const specDir = path.join(TEST_ROOT, 'docs/03-agile/artifacts/specs');
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(path.join(specDir, 'spec-914-test.md'), '# spec', 'utf8');
  const r = await run('delivery-gate', writeTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
});

test('GATE: implement phase + task-breakdown missing → deny', async () => {
  process.env.ASTRA_SDLC_PHASE = 'implement';
  const r = await run('delivery-gate', writeTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /task-breakdown/);
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /\/design/);
});

test('GATE: no phase declared → allow (fail-open, no false positive)', async () => {
  delete process.env.ASTRA_SDLC_PHASE;
  const r = await run('delivery-gate', writeTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
});

test('GATE: read tool → allow (checking artifact requires read)', async () => {
  process.env.ASTRA_SDLC_PHASE = 'design';
  const readInput = JSON.stringify({
    sessionId: SESSION,
    toolName: 'read_file',
    toolInput: { filePath: '/tmp/x.ts' },
    hookEventName: 'PreToolUse',
  });
  const r = await run('delivery-gate', readInput, {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
});

test('GATE: unknown phase → allow', async () => {
  process.env.ASTRA_SDLC_PHASE = 'unknown-phase';
  const r = await run('delivery-gate', writeTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
});

test('GATE: implement phase + task-breakdown present → allow', async () => {
  process.env.ASTRA_SDLC_PHASE = 'implement';
  const tbDir = path.join(TEST_ROOT, 'docs/03-agile/artifacts/task-breakdowns');
  fs.mkdirSync(tbDir, { recursive: true });
  fs.writeFileSync(path.join(tbDir, 'task-breakdown-914-test.md'), '# tb', 'utf8');
  const r = await run('delivery-gate', writeTool(), {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
});
