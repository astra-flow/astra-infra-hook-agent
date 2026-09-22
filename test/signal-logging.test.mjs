/**
 * signal-logging.test.mjs — signals.jsonl 留痕写入（#1020 T014）
 *
 * 覆盖：
 *   1. 行格式完整性：source_issue_id/signal_type/layer/direction/description/status/session_id（FR-011）
 *   2. 默认值：signal_type=gap / layer=L2 / direction=backward / status=pending
 *   3. DB 不可达降级：JSONL 即本地日志，写失败返回 false 不抛错（FR-011 降级语义）
 *   4. resolveSourceIssue：session-issue-link 文件解析（契约行格式）/ 无关联置 null / 文件缺失 null
 *   5. O_APPEND 追加不覆盖（多次写入）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeSignal, resolveSourceIssue } from '../src/lib/audit.mjs';

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-hook-sig-'));

test('SL1: 行格式完整性——7 字段 + 默认值（gap/L2/backward/pending）', () => {
  const file = path.join(TEST_DIR, 'sig1.jsonl');
  const ok = writeSignal(
    { description: '[Layer: L2] 同工具连续调用 12 次触发兜底熔断——工具 edit_file', sessionId: 'sess-sig-1' },
    { file, clock: () => new Date('2026-09-22T00:00:00Z') },
  );
  assert.equal(ok, true);
  const rec = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  assert.deepEqual(
    Object.keys(rec).sort(),
    ['description', 'direction', 'layer', 'session_id', 'signal_type', 'source_issue_id', 'status', 'ts'].sort()
  );
  assert.equal(rec.signal_type, 'gap');
  assert.equal(rec.layer, 'L2');
  assert.equal(rec.direction, 'backward');
  assert.equal(rec.status, 'pending');
  assert.equal(rec.session_id, 'sess-sig-1');
  assert.equal(rec.ts, '2026-09-22T00:00:00.000Z');
  assert.match(rec.description, /兜底熔断/);
});

test('SL2: 显式字段透传（source_issue_id/自定义 layer）', () => {
  const file = path.join(TEST_DIR, 'sig2.jsonl');
  writeSignal(
    {
      sourceIssueId: 1020,
      signalType: 'gap',
      layer: 'L3',
      description: '工具平台层缺口',
      sessionId: 'sess-sig-2',
      status: 'pending',
    },
    { file, clock: () => new Date('2026-09-22T00:01:00Z') },
  );
  const rec = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  assert.equal(rec.source_issue_id, 1020);
  assert.equal(rec.layer, 'L3');
});

test('SL3: DB 不可达降级——写失败返回 false 不抛错（FR-011 降级语义）', () => {
  // 不可写路径（文件名是目录）→ appendFileSync 抛错 → writeSignal 捕获返回 false
  const dirAsFile = path.join(TEST_DIR, 'unwritable.jsonl');
  fs.mkdirSync(dirAsFile); // 同名目录使文件写入必然失败
  const ok = writeSignal(
    { description: 'x', sessionId: 'sess-sig-3' },
    { file: dirAsFile },
  );
  assert.equal(ok, false, '写失败返回 false（fail-open，不阻塞拦截）');
});

test('SL4: 多次写入追加不覆盖（O_APPEND）', () => {
  const file = path.join(TEST_DIR, 'sig4.jsonl');
  for (let i = 1; i <= 3; i++) {
    writeSignal({ description: `event-${i}`, sessionId: 'sess-sig-4' }, { file });
  }
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(JSON.parse(lines[0]).description, /event-1/);
  assert.match(JSON.parse(lines[2]).description, /event-3/);
});

test('SL5: resolveSourceIssue——session-issue-link 契约行解析', () => {
  const linkFile = path.join(TEST_DIR, 'issue-link.md');
  fs.writeFileSync(linkFile, [
    '- 2026-09-22 08:00:00 | SessionStart | session=sess-A | issue=#1020',
    '- 2026-09-22 08:05:00 | PostToolUse | session=sess-B | issue=#993',
    '- 2026-09-22 08:10:00 | SessionStart | session=sess-A | issue=#1054',
  ].join('\n'));
  // 倒序取最近一条
  assert.equal(resolveSourceIssue('sess-A', { file: linkFile }), 1054);
  assert.equal(resolveSourceIssue('sess-B', { file: linkFile }), 993);
});

test('SL6: resolveSourceIssue——无关联会话/文件缺失 → null（fail-open）', () => {
  const linkFile = path.join(TEST_DIR, 'issue-link.md');
  assert.equal(resolveSourceIssue('sess-unknown', { file: linkFile }), null);
  assert.equal(resolveSourceIssue('sess-any', { file: path.join(TEST_DIR, 'missing.md') }), null);
});
