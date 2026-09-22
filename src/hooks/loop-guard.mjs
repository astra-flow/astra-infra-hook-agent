/**
 * loop-guard.mjs — PreToolUse 重复执行检测（防死循环）
 *
 * 迁移自 .github/hooks/loop-guard.sh，机制对齐：
 *   - crypto sha256 指纹（替代 shasum）
 *   - 连续 N 次相同指纹 → deny（默认 3 次）
 *   - HOT_TOOLS 预过滤（CP-03）：非白名单工具直接跳过，避免无关调用开销
 *   - 状态存 ~/.astra/hooks/loop-guard/<sessionId>.json（原子写 + 文件锁）
 *
 * 输出：allow（正常）/ deny（连续重复拦截）/ 默认 fail-open
 */
import crypto from 'node:crypto';
import { buildDeny, buildAsk, buildAllow, buildCircuitBreaker } from '../lib/decision.mjs';
import { updateState } from '../lib/state.mjs';
import { isExemptTool } from '../lib/validate.mjs';
import { loadBands } from '../lib/config.mjs';
import { classifyError, ERROR_CLASSES } from '../lib/error-class.mjs';
import { writeSignal } from '../lib/audit.mjs';

/**
 * @param {object} input - 归一化输入（camelCase）
 * @param {object} meta - hook 元数据
 */
export default async function loopGuard(input, meta, { debug = false } = {}) {
  const { toolName, toolInput, sessionId, hookEventName } = input;

  // 预过滤（2026-09-01 语义反转）：豁免名单模式——只读工具跳过，其余全部监控
  // （#1020 FR-014：豁免同时覆盖苗头提醒与同工具计数——只读轮询/浏览是合法模式）
  if (isExemptTool(toolName, meta.exemptTools)) {
    if (debug) console.error(`[loop-guard] tool "${toolName}" exempt, skip`);
    return buildAllow('loop-guard: tool exempt');
  }

  if (!sessionId) return buildAllow('loop-guard: no session');

  // ===== PostToolUse 分支（#1020 US4/US5，R3/R6 决策）=====
  // 错误分类（权限即停）+ 终端续行启发式提醒。PreToolUse 无法感知结果，
  // 两级配合：PostToolUse 记录权限标记/空响应计数 → PreToolUse 拦截/提醒。
  if (hookEventName === 'PostToolUse') {
    return postToolUseHandler(input, meta, { debug });
  }

  // 指纹：工具名 + 参数。性能优化（perf High #2）：
  // 不做全量深拷贝+键排序，仅对 JSON 字符串化结果截断（FINGERPRINT_MAX）再 hash。
  // 截断保留参数前缀足以区分不同调用；超大输入（create_file/read_file）不再 O(n) 深拷贝。
  const fingerprint = crypto
    .createHash('sha256')
    .update(toolName + stableFingerprint(toolInput))
    .digest('hex');

  // 阈值优先级（#916）：bands.yaml（可调配置）> meta（HOOK_METADATA 内置）> 硬编码兜底
  const bandsCfg = loadBands()['loop-guard'] || {};
  const threshold = bandsCfg.threshold || meta.threshold || 3;
  const nudgeThreshold = bandsCfg.nudgeThreshold || meta.nudgeThreshold || 2;
  const toolStreakLimit = bandsCfg.toolStreakLimit || meta.toolStreakLimit || 12;

  // 原子读-改-写：维护该 session 的连续指纹历史 + 同工具计数 + 苗头周期 + 权限标记
  const state = await updateState('loop-guard', sessionId, (prev) => {
    const hist = (prev && Array.isArray(prev.history)) ? prev.history : [];
    // 相同指纹计数
    let streak = (prev && prev.streak && prev.lastFp === fingerprint) ? prev.streak : 0;
    streak += 1;
    const nextHist = [...hist, fingerprint].slice(-(meta.maxHistory || 50));

    // #1020 同工具连续计数（FR-006，不看参数）：换工具即重置
    const toolStreak = (prev && prev.lastTool === toolName) ? (prev.toolStreak || 0) + 1 : 1;

    // #1020 苗头周期（FR-002，噪声控制）：换工具或已提醒后确认继续 → 新周期
    const nudgeCycle = (prev && prev.lastTool === toolName) ? (prev.nudgeCycle || 0) : 0;

    return {
      history: nextHist,
      streak,
      lastFp: fingerprint,
      toolStreak,
      lastTool: toolName,
      nudgeCycle,
      nudgeDone: (prev && prev.lastTool === toolName) ? (prev.nudgeDone || false) : false,
      updatedAt: Date.now(),
    };
  });

  const streak = state?.streak || 1;
  const toolStreak = state?.toolStreak || 1;

  // ===== 权限标记拦截（#1020 US4，FR-008）=====
  // PostToolUse 已记录权限错误 → 同类工具重试直接拦截（无需计数达标）
  if (state?.permissionFlag && state?.permissionTool === toolName) {
    return buildDeny(
      `[权限错误重试拦截] 工具 \`${toolName}\` 刚返回权限类错误（403/401），重试已被拦截。\n\n` +
      `- 权限错误不可重试：重试无意义且可能触发安全审计\n` +
      `- 下一步行动（任选其一）：\n` +
      `  1. 改用其他工具或方案完成同一目标\n` +
      `  2. 向用户文字报告权限问题并等待指示`,
      hookEventName || 'PreToolUse',
      `[astra-hook loop-guard] 工具 ${toolName} 刚返回权限类错误，重试已被拦截。` +
      `权限错误不会因重试而恢复。请改用其他方案，或向用户报告并等待指示。`
    );
  }

  // ===== 兜底第四轨道（#1020 US3，FR-006/FR-011，R8）=====
  // 同工具连续调用达 toolStreakLimit → 直接 ask 人工审批（引导已失效，宁可严拦）
  // + signals 留痕（FR-011：JSONL 缓冲，fail-open 不阻塞拦截）
  if (toolStreak >= toolStreakLimit) {
    writeSignal({
      signalType: 'gap',
      layer: 'L2',
      direction: 'backward',
      description: `[Layer: L2] 同工具连续调用 ${toolStreak} 次触发兜底熔断（参数变异逃逸指纹去重）——工具 ${toolName}`,
      sessionId,
    });
    return buildAsk(
      `[防循环兜底·人工审批] 工具 \`${toolName}\` 已被连续调用 ${toolStreak} 次（无论参数如何变化），触发兜底熔断。\n\n` +
      `- 判定：连续调用同一工具本身即视为循环嫌疑（参数变异逃逸指纹去重的盲区）\n` +
      `- 禁止通过变更参数继续——那正是本轨道要拦截的模式\n` +
      `- 建议：拒绝本次调用，要求 Agent 换用不同方案或直接报告阻塞状态`,
      hookEventName || 'PreToolUse',
      `[astra-hook loop-guard 兜底] 工具 ${toolName} 已连续 ${toolStreak} 次调用（参数各不相同），` +
      `这是"换着花样做同一件错事"的循环模式。请立即停止：换用不同方案、或向用户文字报告阻塞状态——` +
      `严禁通过变更参数继续。`
    );
  }

  // 连续达到阈值 → 拦截（#957：deny 自动拦截对计划固位失败模式无效——#948 二次事故
  // 290 次拦截仍重试。升级为 ask 强制人工审批：模型无法绕过，用户可批准/拒绝/终止）
  // #1020 FR-013：指纹命中优先于苗头提醒——同参数 streak 达阈值时 deny 优先，
  // 苗头只对“未达指纹阈值”的同工具调用生效（否则 threshold=2 场景下 deny 被抶截）
  if (streak >= threshold) {
    const summary = summarizeToolInput(toolInput);
    const breakerLimit = bandsCfg.breakerLimit || meta.breakerLimit || 8;
    // 升级阈值（#957 P0）：bands.yaml askThreshold > threshold+2 兜底
    const askThreshold = bandsCfg.askThreshold || threshold + 2;

    // 熔断器（#957 终态改 ask 兜底）：连续拦截达 breakerLimit → 强制人工审批。
    // 原设计为 continue:false 强制终止回合，但 #948 二次事故实证：VS Code 实际
    // 环境中熔断未能终止回合（Agent 熔断后仍重试至 290 次）。ask 是平台语义中
    // 唯一无法被模型自动绕过的停止信号——工具调用挂起等待用户确认。
    if (streak >= breakerLimit) {
      return buildAsk(
        `[防循环熔断·人工审批] 工具 \`${toolName}\` 已被连续拦截 ${streak - threshold + 1} 次（相同参数第 ${streak} 次调用），升级为强制人工审批。\n\n` +
        `- 最近一次参数：\`${summary}\`\n` +
        `- 触发条件：连续 ${breakerLimit} 次拦截后仍未改变行为\n` +
        `- 建议：拒绝本次调用，并要求 Agent 换用不同方案或直接报告阻塞状态`,
        hookEventName || 'PreToolUse',
        `[astra-hook loop-guard 熔断] 工具 ${toolName} 连续 ${streak} 次相同参数调用，已拦截 ${streak - threshold + 1} 次仍未改变行为，本次调用已升级为人工审批。` +
        `这不是瞬时故障，不会因重试而恢复。请立即停止该工具调用：换用不同方案、或直接向用户文字报告阻塞状态——严禁原样重试。`
      );
    }

    // 连续拦截升级：streak 达到 askThreshold，说明 Agent 未响应纠偏指引，升级为 ask
    // （#957 P0：原升级警告仍为 deny 自动拦截，实证无效；ask 强制用户介入）
    if (streak >= askThreshold) {
      return buildAsk(
        `[防循环升级·人工审批] 工具 \`${toolName}\` 已被连续拦截 ${streak - threshold + 1} 次（相同参数第 ${streak} 次调用），Agent 未响应纠偏指引，升级为强制人工审批。\n\n` +
        `- 最近一次参数：\`${summary}\`\n` +
        `- 达到 ${breakerLimit} 次将保持人工审批直至行为改变\n` +
        `- 建议：拒绝本次调用，并要求 Agent 换用不同方案或直接报告阻塞状态`,
        hookEventName || 'PreToolUse',
        `[astra-hook loop-guard 升级] 工具 ${toolName} 已连续拦截 ${streak - threshold + 1} 次仍未改变行为，本次调用需用户确认。` +
        `这不是瞬时故障，不会因重试而恢复。请立即停止该工具调用：换用不同方案、或直接向用户文字报告阻塞状态——严禁原样重试。`
      );
    }

    // 首次拦截（streak == threshold）：保留 deny + 正向指令（#957 P1a：
    // 业界 loop-breaker 采用正向措辞，明确告知替代动作而非否定式警告）
    // #1020 FR-003（US2）：删除"参数变化会重置计数"类绕过指引——#993 实证该表述
    // 被模型放大为换参数绕过策略；统一"停止并报告"三选项语义
    return buildDeny(
      `[防循环拦截] 检测到重复执行：工具 \`${toolName}\` 已连续调用 ${streak} 次且无进展。\n\n` +
      `- 最近一次参数：\`${summary}\`\n` +
      `- 原因：相同工具 + 相同参数重复执行，疑似陷入死循环\n` +
      `- 下一步行动（任选其一）：\n` +
      `  1. 改用其他工具或方案完成同一目标\n` +
      `  2. 停止调用，向用户文字报告阻塞状态并等待指示\n` +
      `- 注意：原样重试将被再次拦截；连续拦截 ${askThreshold} 次后将升级为人工审批`,
      hookEventName || 'PreToolUse',
      // systemMessage：注入模型上下文，确保 Agent 拿到纠偏信息（而非只看到"被拒绝"）
      `[astra-hook loop-guard] 工具 ${toolName} 已连续 ${streak} 次以相同参数调用，本次调用已被阻止。` +
      `这不是瞬时故障，不会因重试而恢复。请立即改变行为：换用不同方案，或向用户文字报告阻塞状态并等待指示。` +
      ` 连续拦截 ${askThreshold} 次后将升级为人工审批。`
    );
  }

  // ===== 苗头提醒轨道（#1020 US1，FR-001/FR-002，R1）=====
  // 同工具连续调用达 nudgeThreshold 且未达指纹阈值 → allow + 软引导（不阻断）
  // 周期内只提醒一次；指纹拦截优先（FR-013），苗头只对"未达指纹阈值"的调用生效
  if (toolStreak >= nudgeThreshold && !(state?.nudgeDone)) {
    // 标记本周期已提醒（原子写，防重复轰炸）
    await updateState('loop-guard', sessionId, (prev) => ({
      ...(prev || {}),
      nudgeDone: true,
      updatedAt: Date.now(),
    }));
    const nudgeMsg =
      `[循环苗头提醒] 工具 \`${toolName}\` 已被连续调用 ${toolStreak} 次。\n\n` +
      `- 请确认：本次调用与上次的目标是否不同？\n` +
      `- 若目标相同：立即停止，改用其他方案或向用户文字报告阻塞状态\n` +
      `- 若目标不同（合法批量操作）：继续即可，本周期内不会重复提醒`;
    return buildAllow(
      `loop-guard: nudge (toolStreak=${toolStreak})`,
      hookEventName || 'PreToolUse',
      `[astra-hook loop-guard 苗头提醒] 连续调用同一工具本身即视为循环嫌疑。` +
      `请确认本次调用目标与上次不同；若相同，停止并改道或报告——禁止通过变更参数继续。`,
      nudgeMsg
    );
  }

  return buildAllow(`loop-guard: streak=${streak}/${threshold} toolStreak=${toolStreak}`, hookEventName || 'PreToolUse');
}

/**
 * PostToolUse 处理器（#1020 US4/US5，R3/R6 决策）
 *
 * US4 权限即停：toolResponse 匹配 error-classes 权限类模式 → 置 permissionFlag
 * （PreToolUse 侧检查后直接拦截同类重试，FR-008）。
 * US5 终端续行启发式：终端类工具连续 2 次空响应 → allow + 诊断提醒（软引导）。
 *
 * @param {object} input 归一化输入
 * @param {object} meta hook 元数据
 */
async function postToolUseHandler(input, meta, { debug = false } = {}) {
  const { toolName, toolResponse, sessionId, hookEventName } = input;
  if (!sessionId) return buildAllow('loop-guard: post no session');

  const bandsCfg = loadBands()['loop-guard'] || {};
  const nudgeThreshold = bandsCfg.nudgeThreshold || meta.nudgeThreshold || 2;

  // US4：错误分类（权限类 → 置标记；分类失败 fail-open 归瞬时）
  const errorClass = classifyError(toolResponse);
  if (errorClass === ERROR_CLASSES.PERMISSION) {
    await updateState('loop-guard', sessionId, (prev) => ({
      ...(prev || {}),
      permissionFlag: true,
      permissionTool: toolName,
      updatedAt: Date.now(),
    }));
    return buildAllow(
      `loop-guard: permission error recorded (${toolName})`,
      hookEventName || 'PostToolUse',
      `[astra-hook loop-guard] 工具 ${toolName} 返回权限类错误（403/401）。` +
      `权限错误不可重试——重试无意义且可能触发安全审计。请立即停止重试：改用其他方案，或向用户报告并等待指示。`,
      `[权限类错误·停止重试] 工具 \`${toolName}\` 返回 403/401 类错误。` +
      `这不是瞬时故障，重试不会恢复。请改用其他方案完成目标，或向用户文字报告并等待指示。`
    );
  }

  // US5：终端续行启发式（终端类工具连续 2 次空响应 → 诊断提醒）
  const TERMINAL_TOOLS = ['run_in_terminal', 'send_to_terminal'];
  if (TERMINAL_TOOLS.includes(toolName)) {
    const isEmpty = !toolResponse || String(toolResponse).trim() === '';
    const state = await updateState('loop-guard', sessionId, (prev) => {
      const emptyStreak = (prev && prev.lastTool === toolName && isEmpty) ? (prev.emptyStreak || 0) + 1 : (isEmpty ? 1 : 0);
      return { ...(prev || {}), emptyStreak, lastTool: toolName, updatedAt: Date.now() };
    });
    const emptyStreak = state?.emptyStreak || 0;
    if (emptyStreak >= nudgeThreshold) {
      // 重置计数（本周期已提醒）
      await updateState('loop-guard', sessionId, (prev) => ({ ...(prev || {}), emptyStreak: 0, updatedAt: Date.now() }));
      return buildAllow(
        `loop-guard: terminal empty-response nudge (${emptyStreak})`,
        hookEventName || 'PostToolUse',
        `[astra-hook loop-guard] 终端连续 ${emptyStreak} 次命令无输出——疑似进入续行模式（如 dquote>）。` +
        `请先发 Ctrl+C 再诊断，勿继续探测；若刚执行的是长时命令请先确认（timeout 护栏属既有规则）。`,
        `[疑似终端续行模式] 连续 ${emptyStreak} 次命令无输出。\n` +
        `- 可能原因：未闭合引号/多行命令导致 shell 进入续行模式，输入被静默吞掉\n` +
        `- 正确动作：立即发 Ctrl+C → 用 echo 探测终端是否恢复 → 诊断原始命令\n` +
        `- 禁止：继续发送探测命令（各不相同的探测正是 #948 第五次事故的循环模式）\n` +
        `- 若刚执行的是长时命令（测试/构建），请先确认是否仍在运行`
      );
    }
  }

  if (debug) console.error(`[loop-guard] post: ${toolName} class=${errorClass}`);
  return buildAllow(`loop-guard: post ok (${toolName})`, hookEventName || 'PostToolUse');
}

/** 指纹输入截断上限（防超大 toolInput 全量 hash） */
const FINGERPRINT_MAX = 2048;

/**
 * 稳定指纹源：JSON 字符串化 + 截断。
 * - 不做键排序/深拷贝（性能）：参数对象键序通常稳定（同一工具同一调用方），
 *   即便键序漂移导致指纹不同，最坏结果是少拦截一次重复，可接受（fail-open 语义）。
 * - 截断保留前缀，足以区分不同参数内容。
 */
function stableFingerprint(obj) {
  let s;
  try {
    s = JSON.stringify(obj || {});
  } catch {
    s = String(obj);
  }
  return s.length > FINGERPRINT_MAX ? s.slice(0, FINGERPRINT_MAX) : s;
}

/** 敏感键匹配（隐藏 content/command/apiKey 等） */
const SENSITIVE_KEY_RE = /(content|command|body|api[_-]?key|token|password|secret|code)/i;

/**
 * 工具参数摘要（deny 理由用）：键名化 + 脱敏，避免回显敏感参数（sec Medium）。
 * 输出形如：`{ filePath: "/tmp/x", content: [REDACTED] }`
 */
function summarizeToolInput(toolInput) {
  try {
    if (toolInput === null || typeof toolInput !== 'object') return '[unserializable]';
    const parts = [];
    for (const [k, v] of Object.entries(toolInput)) {
      if (SENSITIVE_KEY_RE.test(k)) {
        parts.push(`${k}: [REDACTED]`);
      } else if (typeof v === 'string') {
        parts.push(`${k}: ${v.length > 80 ? `${v.slice(0, 80)}...` : v}`);
      } else if (typeof v === 'object') {
        // 嵌套对象统一输出键名+长度（sec 复审 Medium 修复）：
        // 避免 ≤80 字符时完整打印嵌套对象的敏感键值（如 {config:{apiKey:"sk-..."}}）
        parts.push(`${k}: {keys: ${Object.keys(v).join(',') || '(empty)'}}`);
      } else {
        parts.push(`${k}: ${String(v)}`);
      }
    }
    return `{ ${parts.join(', ')} }`;
  } catch {
    return '[unserializable]';
  }
}
