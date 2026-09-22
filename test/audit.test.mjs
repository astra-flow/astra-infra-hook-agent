/**
 * audit.test.mjs — 审计写入模块单元测试（#993 T007）
 *
 * 覆盖（AC：新增代码 100%，含并发写安全）：
 * - buildAuditRecord：三决策类型字段完整性（7 字段）/ 枚举归一 / duration_ms
 * - clampLine：超长行截断（O_APPEND 原子写前提）
 * - writeAudit：正常写入 / fail-open（写入异常不影响返回）/ 依赖注入
 * - extractSessionId：session 提取 / 非法 JSON
 * - 并发写安全：Promise.all 并发 N 次写入无交错损坏
 * - 时延预算：审计路径 < 5ms
 * - runtime 集成：决策出口审计旁路（决策值不受审计影响）
 *
 * 运行：node --test test/audit.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAuditRecord,
  clampLine,
  writeAudit,
  extractSessionId,
  defaultAuditFile,
  MAX_LINE_BYTES,
} from '../src/lib/audit.mjs';
import { run } from '../src/runtime.mjs';

/** 创建临时缓冲文件 */
function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), 'astra-audit-test-'));
  const file = join(dir, 'audit.jsonl');
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 构造决策对象 */
function decisionOf(d, reason = 'test reason') {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d, reason } };
}

describe('buildAuditRecord', () => {
  test('allow/deny/ask 三决策类型均产出 8 字段完整记录（#1020 加 decision_detail）', () => {
    for (const d of ['allow', 'deny', 'ask']) {
      const rec = buildAuditRecord(decisionOf(d), {
        hookName: 'loop-guard',
        toolName: 'Bash',
        sessionId: 'sess-1',
        durationMs: 12.4,
        now: new Date('2026-09-14T08:00:00Z'),
      });
      assert.deepEqual(
        Object.keys(rec).sort(),
        ['decision', 'decision_detail', 'duration_ms', 'hook_name', 'reason', 'session_id', 'tool_name', 'ts'].sort()
      );
      assert.equal(rec.decision, d);
      assert.equal(rec.hook_name, 'loop-guard');
      assert.equal(rec.tool_name, 'Bash');
      assert.equal(rec.session_id, 'sess-1');
      assert.equal(rec.duration_ms, 12); // 四舍五入
      assert.equal(rec.ts, '2026-09-14T08:00:00.000Z');
      assert.equal(rec.reason, 'test reason');
      assert.equal(rec.decision_detail, null); // 未传 detail 时为 null（向后兼容）
    }
  });

  test('非法决策值归一为 allow（防御性，不抛错）', () => {
    const rec = buildAuditRecord(
      { hookSpecificOutput: { permissionDecision: 'block-everything' } },
      { hookName: 'x' }
    );
    assert.equal(rec.decision, 'allow');
  });

  test('缺失字段容错：toolName/sessionId/durationMs 缺失 → null', () => {
    const rec = buildAuditRecord(decisionOf('deny'), { hookName: 'x' });
    assert.equal(rec.tool_name, null);
    assert.equal(rec.session_id, null);
    assert.equal(rec.duration_ms, null);
  });

  test('非有限 duration_ms → null', () => {
    const rec = buildAuditRecord(decisionOf('allow'), { hookName: 'x', durationMs: NaN });
    assert.equal(rec.duration_ms, null);
  });
});

describe('clampLine', () => {
  test('未超限行原样返回', () => {
    const line = JSON.stringify({ reason: 'short' });
    assert.equal(clampLine(line), line);
  });

  test('超长行截断后不超过上限且仍为合法 JSON', () => {
    const long = JSON.stringify({
      ts: '2026-09-14T08:00:00.000Z',
      hook_name: 'loop-guard',
      tool_name: 'Bash',
      decision: 'deny',
      reason: 'x'.repeat(5000),
      session_id: 's',
      duration_ms: 1,
    });
    const clamped = clampLine(long);
    assert.ok(Buffer.byteLength(clamped, 'utf8') <= MAX_LINE_BYTES);
    const parsed = JSON.parse(clamped); // 仍为合法 JSON
    assert.equal(parsed.decision, 'deny');
    assert.ok(parsed.reason.endsWith('…[clamped]'));
  });
});

describe('writeAudit', () => {
  test('正常写入：JSONL 追加一行，字段与 PG hook_audit 7 字段对应', () => {
    const { file, cleanup } = tmpFile();
    try {
      const ok = writeAudit(decisionOf('deny', 'blocked'), {
        hookName: 'loop-guard',
        toolName: 'Bash',
        sessionId: 's1',
        durationMs: 3,
      }, { file });
      assert.equal(ok, true);
      const lines = readFileSync(file, 'utf8').trim().split('\n');
      assert.equal(lines.length, 1);
      const rec = JSON.parse(lines[0]);
      assert.equal(rec.decision, 'deny');
      assert.equal(rec.hook_name, 'loop-guard');
      assert.equal(rec.tool_name, 'Bash');
      assert.equal(rec.session_id, 's1');
      assert.equal(rec.duration_ms, 3);
      assert.ok(rec.ts);
      assert.equal(rec.reason, 'blocked');
    } finally {
      cleanup();
    }
  });

  test('fail-open：写入目标不可写时返回 false 且不抛出', () => {
    // /nonexistent-root-dir 不可创建 → appendFileSync 抛出 → 静默吞掉
    const ok = writeAudit(decisionOf('allow'), { hookName: 'x' }, {
      file: '/nonexistent-root-dir-993/audit.jsonl',
    });
    assert.equal(ok, false);
  });

  test('多次写入追加不覆盖', () => {
    const { file, cleanup } = tmpFile();
    try {
      writeAudit(decisionOf('allow'), { hookName: 'a' }, { file });
      writeAudit(decisionOf('deny'), { hookName: 'b' }, { file });
      const lines = readFileSync(file, 'utf8').trim().split('\n');
      assert.equal(lines.length, 2);
      assert.equal(JSON.parse(lines[0]).decision, 'allow');
      assert.equal(JSON.parse(lines[1]).decision, 'deny');
    } finally {
      cleanup();
    }
  });
});

describe('并发写安全（AC：含并发写安全）', () => {
  test('Promise.all 并发 200 次写入：200 行完整、无交错损坏', async () => {
    const { file, cleanup } = tmpFile();
    try {
      const N = 200;
      await Promise.all(
        Array.from({ length: N }, (_, i) =>
          Promise.resolve().then(() =>
            writeAudit(decisionOf(i % 2 === 0 ? 'allow' : 'deny', `r${i}`), {
              hookName: `hook-${i}`,
              toolName: 'Bash',
              sessionId: `s${i}`,
              durationMs: i,
            }, { file })
          )
        )
      );
      const content = readFileSync(file, 'utf8');
      const lines = content.trim().split('\n');
      assert.equal(lines.length, N, `期望 ${N} 行，实际 ${lines.length}`);
      // 每行均为合法 JSON（无交错损坏）
      const decisions = new Set();
      for (const line of lines) {
        const rec = JSON.parse(line); // 任一行损坏则抛出
        decisions.add(rec.decision);
      }
      assert.deepEqual([...decisions].sort(), ['allow', 'deny']);
    } finally {
      cleanup();
    }
  });
});

describe('时延预算（审计路径 < 5ms）', () => {
  test('单次 writeAudit 耗时 < 5ms（预热后）', () => {
    const { file, cleanup } = tmpFile();
    try {
      // 预热（首次调用含模块内路径解析）
      writeAudit(decisionOf('allow'), { hookName: 'warm' }, { file });
      const start = process.hrtime.bigint();
      writeAudit(decisionOf('deny'), { hookName: 'timed' }, { file });
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      assert.ok(ms < 5, `审计路径耗时 ${ms.toFixed(3)}ms，超出 5ms 预算`);
    } finally {
      cleanup();
    }
  });
});

describe('extractSessionId', () => {
  test('snake_case session_id 提取', () => {
    assert.equal(extractSessionId('{"session_id":"abc"}'), 'abc');
  });
  test('camelCase sessionId 提取', () => {
    assert.equal(extractSessionId('{"sessionId":"xyz"}'), 'xyz');
  });
  test('非法 JSON → null（不抛出）', () => {
    assert.equal(extractSessionId('not-json'), null);
  });
  test('缺失字段 → null', () => {
    assert.equal(extractSessionId('{"tool_name":"Bash"}'), null);
  });
});

describe('defaultAuditFile', () => {
  test('ASTRA_HOOK_AUDIT_FILE 环境变量优先', () => {
    const orig = process.env.ASTRA_HOOK_AUDIT_FILE;
    try {
      process.env.ASTRA_HOOK_AUDIT_FILE = '/custom/path.jsonl';
      assert.equal(defaultAuditFile(), '/custom/path.jsonl');
    } finally {
      if (orig === undefined) delete process.env.ASTRA_HOOK_AUDIT_FILE;
      else process.env.ASTRA_HOOK_AUDIT_FILE = orig;
    }
  });
  test('默认路径落在 astra-hook 目录下', () => {
    const p = defaultAuditFile();
    assert.ok(p.endsWith('audit.jsonl'));
    assert.ok(p.includes('astra-hook'));
  });
});

describe('runtime 决策出口审计集成（T006）', () => {
  test('run() 决策返回值不受审计影响（fail-open 语义保持）', async () => {
    const { file, cleanup } = tmpFile();
    const orig = process.env.ASTRA_HOOK_AUDIT_FILE;
    process.env.ASTRA_HOOK_AUDIT_FILE = file;
    try {
      // 未知 hook → fail-open 决策，但审计仍应写入
      const d = await run('no-such-hook', JSON.stringify({ session_id: 's-int' }));
      assert.equal(d.hookSpecificOutput.permissionDecision, 'allow');
      const lines = readFileSync(file, 'utf8').trim().split('\n');
      assert.equal(lines.length, 1);
      const rec = JSON.parse(lines[0]);
      assert.equal(rec.hook_name, 'no-such-hook');
      assert.equal(rec.session_id, 's-int');
      assert.equal(rec.decision, 'allow');
      assert.ok(Number.isFinite(rec.duration_ms));
    } finally {
      cleanup();
      if (orig === undefined) delete process.env.ASTRA_HOOK_AUDIT_FILE;
      else process.env.ASTRA_HOOK_AUDIT_FILE = orig;
    }
  });

  test('审计文件不可写时 run() 决策不受影响', async () => {
    const orig = process.env.ASTRA_HOOK_AUDIT_FILE;
    process.env.ASTRA_HOOK_AUDIT_FILE = '/nonexistent-root-dir-993/audit.jsonl';
    try {
      const d = await run('no-such-hook', '{}');
      assert.equal(d.hookSpecificOutput.permissionDecision, 'allow');
    } finally {
      if (orig === undefined) delete process.env.ASTRA_HOOK_AUDIT_FILE;
      else process.env.ASTRA_HOOK_AUDIT_FILE = orig;
    }
  });
});
