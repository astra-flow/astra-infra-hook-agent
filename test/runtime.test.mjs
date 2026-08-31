/**
 * runtime.test.mjs — 运行时 evals（CP-01~05 验收验证）
 *
 * 覆盖：
 *   - fail-open 语义（坏输入/未知 hook/异常 → continue）
 *   - 平台归一化（snake_case → camelCase）
 *   - 输入白名单校验
 *   - 元数据 schema 自检
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/runtime.mjs';
import { normalizeInput } from '../src/lib/normalize.mjs';
import { validateInput, isSafePath } from '../src/lib/validate.mjs';
import { validateMetadataSchema } from '../src/lib/config.mjs';

test('CP-05: metadata schema valid', () => {
  const { valid, errors } = validateMetadataSchema();
  assert.equal(valid, true, errors.join('; '));
});

test('CP-01: fail-open on invalid stdin JSON', async () => {
  const r = await run('loop-guard', 'not-json{{{', {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
});

test('CP-01: fail-open on unknown hook', async () => {
  const r = await run('nonexistent-hook', '{}', {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
});

test('CP-01: fail-open on empty input', async () => {
  const r = await run('loop-guard', '', {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
});

test('CP-04: normalize snake_case → camelCase (Claude Code)', () => {
  const input = normalizeInput({
    session_id: 's1',
    tool_name: 'Write',
    tool_input: { file_path: '/a' },
    hook_event_name: 'PreToolUse',
  });
  assert.equal(input.sessionId, 's1');
  assert.equal(input.toolName, 'Write');
  assert.equal(input.hookEventName, 'PreToolUse');
  assert.equal(input.toolInput.filePath, '/a');
});

test('CP-04: normalize preserves camelCase (VS Code)', () => {
  const input = normalizeInput({
    sessionId: 's1',
    toolName: 'create_file',
    toolInput: { filePath: '/a' },
    hookEventName: 'PreToolUse',
  });
  assert.equal(input.sessionId, 's1');
  assert.equal(input.toolName, 'create_file');
  assert.equal(input.toolInput.filePath, '/a');
});

test('CP-05: validate rejects non-object input', () => {
  assert.equal(validateInput(null).valid, false);
  assert.equal(validateInput('str').valid, false);
});

test('CP-05: validate accepts valid input', () => {
  assert.equal(validateInput({ sessionId: 's1', toolName: 'read_file' }).valid, true);
});

test('CP-05: path traversal protection', () => {
  assert.equal(isSafePath('memories/session/issue-link.md'), true);
  assert.equal(isSafePath('../etc/passwd'), false);
  assert.equal(isSafePath('/abs/path'), true);
  assert.equal(isSafePath('a\\..\\b'), false);
});

test('CP-05: isSafePath precise segment check (a..b is valid)', () => {
  assert.equal(isSafePath('a..b'), true);      // 合法文件名，非穿越
  assert.equal(isSafePath('a/../b'), false);   // 穿越段
  assert.equal(isSafePath('../x'), false);     // 穿越段
  assert.equal(isSafePath('a/b/c'), true);
});

test('CP-05: MAX_INPUT_BYTES enforced', async () => {
  // 构造 > 1MB 的 prompt 输入 → fail-open（不 deny，但被拦截）
  const bigPrompt = 'x'.repeat(1_100_000);
  const input = JSON.stringify({ sessionId: 's', prompt: bigPrompt, hookEventName: 'UserPromptSubmit' });
  const r = await run('decision-log', input, {});
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow'); // fail-open
});
