/**
 * config.mjs — Hook 元数据 schema 解析与校验（CP-02 结构化配置）
 *
 * 元数据单一来源：本文件内 HOOK_METADATA 表（hook 名 → 事件/超时/平台/依赖）。
 * 运行时通过 lib/config.mjs 读取；`.github/hooks/*.json` 仅存 VS Code 执行配置
 * （command 指向 bin/astra-hook.mjs <hook>），两者职责分离。
 *
 * bands.yaml（#916）：σ 分级边界 + hook 阈值可调配置，loadBands() 加载。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** hook 元数据 schema（平台能力层内部契约） */
export const HOOK_METADATA = {
  'loop-guard': {
    name: 'loop-guard',
    description: 'PreToolUse 重复执行检测（防死循环）',
    events: ['PreToolUse'],
    timeoutMs: 5000,
    platforms: ['vscode', 'claude-code'],
    // 豁免名单（exempt，2026-09-01 语义反转）：只读无害工具跳过指纹检测。
    // 旧 hotTools 白名单模式 = 默认放行未知工具，导致 MCP 工具（如
    // add_issue_comment）重复调用 60+ 次未被拦截（#899 占位评论事故）。
    // 新语义：默认监控所有工具（含 MCP），仅豁免明确只读的工具。
    exemptTools: [
      'read_file', 'Read', 'fetch_webpage', 'grep_search', 'list_dir',
      'file_search', 'view_image', 'copilot_getNotebookSummary',
      'read_notebook_cell_output', 'terminal_last_command', 'terminal_selection',
      'get_task_output', 'get_errors', 'read_page',
      // 轮询/预览类（2026-09-01 误判修复）：连续同参调用是合法等待模式
      'get_terminal_output', 'screenshot_page',
    ],
    threshold: 3, // 连续 N 次相同指纹触发拦截
    maxHistory: 50,
    // 熔断器（2026-09-01）：连续拦截达 breakerLimit 后，从 per-call deny 升级为
    // 终止整个 Agent 回合（continue:false + stopReason）。背景：deny+systemMessage
    // 对陷入"计划固位"失败模式的模型无效（#899 事故：拦截 168 次仍重试），
    // 唯一无法忽略的信号是平台强制终止回合。
    breakerLimit: 8,
  },
  'decision-log': {
    name: 'decision-log',
    description: 'UserPromptSubmit 评审决策自动评论（零 token 审计）',
    events: ['UserPromptSubmit'],
    timeoutMs: 10000,
    platforms: ['vscode', 'claude-code'],
    async: true, // 重操作后台执行，不阻塞
    positivePatterns: ['确认合并', 'Decision:\\s*Approved', 'Approved', '同意', '通过', '确认'],
    negativePatterns: ['拒绝', '需要修改', '重新设计', '暂缓', '不通过', '驳回', 'Needs clarification', 'Rejected'],
  },
  'session-issue-link': {
    name: 'session-issue-link',
    description: '会话↔Issue 关联记录（SessionStart + PostToolUse）',
    events: ['SessionStart', 'PostToolUse'],
    timeoutMs: 5000,
    platforms: ['vscode', 'claude-code'],
    // 写入路径经配置注入（非硬编码，D8 路径防护）
    linkFile: process.env.ASTRA_SESSION_LINK_FILE || 'memories/session/issue-link.md',
  },
  // ---- 交付流门禁 hooks（#976 机制强制层，2 硬 3 软）----
  // 阶段声明契约：Agent 执行交付阶段动作时设置 env ASTRA_SDLC_PHASE
  // （specify|plan|implement|test|converge），未声明 → 放行（fail-open）。
  // artifact 路径：specs/<NNN-feature>/（交付模型 v1.0，speckit 引擎约定）。
  'delivery-branch-guard': {
    name: 'delivery-branch-guard',
    description: '交付门禁（阻断）：implement 阶段写代码前校验当前分支为 feature/hotfix（#976）',
    events: ['PreToolUse'],
    timeoutMs: 5000,
    platforms: ['vscode', 'claude-code'],
    phaseEnv: 'ASTRA_SDLC_PHASE',
    // 阻断级别：deny（分支纪律是红线，main/staging/production 直接改代码不可回退）
    level: 'deny',
    allowedBranchPrefixes: ['feature/', 'hotfix/'],
  },
  'delivery-test-gate': {
    name: 'delivery-test-gate',
    description: '交付门禁（阻断）：converge 阶段前校验测试套件通过记录存在（#976）',
    events: ['PreToolUse'],
    timeoutMs: 5000,
    platforms: ['vscode', 'claude-code'],
    phaseEnv: 'ASTRA_SDLC_PHASE',
    // 阻断级别：deny（测试未过就推进 = 质量红线）
    level: 'deny',
    // 测试通过记录：test.md 含执行记录节，或 CI 结论文件
    testEvidence: 'specs/',
  },
  'delivery-constitution-check': {
    name: 'delivery-constitution-check',
    description: '交付门禁（警告）：plan 产出后校验 plan.md 含 Constitution Check 节（#976）',
    events: ['PostToolUse'],
    timeoutMs: 5000,
    platforms: ['vscode', 'claude-code'],
    phaseEnv: 'ASTRA_SDLC_PHASE',
    // 警告级别：文档规范问题可补，不拦死
    level: 'warn',
  },
  'delivery-workitem-link': {
    name: 'delivery-workitem-link',
    description: '交付门禁（警告）：specify 产出后校验 spec.md 头部含 work-item ID（#976）',
    events: ['PostToolUse'],
    timeoutMs: 5000,
    platforms: ['vscode', 'claude-code'],
    phaseEnv: 'ASTRA_SDLC_PHASE',
    // 警告级别：追溯锚点事后可补
    level: 'warn',
  },
  'delivery-stage-label': {
    name: 'delivery-stage-label',
    description: '交付门禁（警告）：阶段推进时校验 stage:X 标签与实际阶段一致（#976）',
    events: ['PostToolUse'],
    timeoutMs: 5000,
    platforms: ['vscode', 'claude-code'],
    phaseEnv: 'ASTRA_SDLC_PHASE',
    // 警告级别：标签是状态提示，不影响实际交付
    level: 'warn',
  },
};

/**
 * 加载 hook 元数据。
 * @param {string} hookName
 * @returns {object|null} 元数据或 null（未知 hook）
 */
export function loadHookMetadata(hookName) {
  return HOOK_METADATA[hookName] || null;
}

/**
 * 校验 hook 元数据 schema（开发期自检）。
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateMetadataSchema() {
  const errors = [];
  for (const [name, meta] of Object.entries(HOOK_METADATA)) {
    if (!meta.events || !Array.isArray(meta.events) || meta.events.length === 0) {
      errors.push(`${name}: missing events`);
    }
    if (typeof meta.timeoutMs !== 'number') {
      errors.push(`${name}: missing timeoutMs`);
    }
    if (!meta.platforms || !Array.isArray(meta.platforms) || meta.platforms.length === 0) {
      errors.push(`${name}: missing platforms`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * bands.yaml 加载（#916：σ 分级边界可调配置）。
 *
 * 设计要点：
 *   - 零依赖：node 无内置 YAML 解析，bands.yaml 结构受限（两层嵌套 key: value），
 *     手工解析器 ~30 行，避免引入 js-yaml（保持 D1 零第三方依赖决策）
 *   - 兜底：文件缺失/解析失败 → 内置默认值（fail-open，与 hook 整体语义一致）
 *   - 可覆盖：env ASTRA_BANDS_FILE 注入自定义路径（测试/多环境）
 */

/** 内置默认值（bands.yaml 缺失/解析失败时兜底） */
export const BANDS_DEFAULTS = {
  sigma: {
    '1': { action: 'log', description: '仅记录' },
    '2': { action: 'diagnose', description: '只读诊断' },
    '3': { action: 'act', description: '允许行动' },
  },
  'loop-guard': { threshold: 3, breakerLimit: 8, maxHistory: 50 },
};

/** 解析单行 YAML 值（字符串去引号后仍尝试数字/布尔转换） */
function parseYamlValue(raw) {
  let v = raw.trim();
  if (v === '' || v === 'null') return null;
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  return v;
}

/**
 * 极简 YAML 解析（仅支持两层嵌套 mapping + 标量值，不支持列表/多行/锚点）。
 * @param {string} text
 * @returns {object|null} 解析失败返回 null（调用方兜底）
 */
export function parseSimpleYaml(text) {
  try {
    const root = {};
    let section = null;
    let subsection = null;
    for (const line of text.split('\n')) {
      const noComment = line.split('#')[0].rstrip?.() ?? line.split('#')[0].replace(/\s+$/, '');
      if (!noComment.trim()) continue;
      const indent = noComment.length - noComment.trimStart().length;
      const content = noComment.trim();
      const kv = content.match(/^([^:]+):\s*(.*)$/);
      if (!kv) continue;
      const key = kv[1].trim().replace(/^["']|["']$/g, '');
      const value = kv[2];
      if (indent === 0) {
        if (value === '') { section = key; subsection = null; root[key] = root[key] ?? {}; }
        else { root[key] = parseYamlValue(value); section = null; subsection = null; }
      } else if (indent === 2 && section) {
        if (value === '') { subsection = key; root[section][key] = root[section][key] ?? {}; }
        else { root[section][key] = parseYamlValue(value); subsection = null; }
      } else if (indent >= 4 && section && subsection) {
        root[section][subsection][key] = parseYamlValue(value);
      } else if (indent >= 4 && section) {
        root[section][key] = parseYamlValue(value);
      }
    }
    return root;
  } catch {
    return null;
  }
}

/**
 * 加载 bands 配置（σ 分级边界 + hook 阈值）。
 * @returns {object} bands（永远返回可用配置：文件优先，默认值兜底）
 */
export function loadBands() {
  const bandsPath = process.env.ASTRA_BANDS_FILE
    || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'bands.yaml');
  try {
    const parsed = parseSimpleYaml(fs.readFileSync(bandsPath, 'utf8'));
    if (!parsed) return BANDS_DEFAULTS;
    // 深度合并：文件值覆盖默认值，缺失字段用默认值补齐
    const merged = JSON.parse(JSON.stringify(BANDS_DEFAULTS));
    for (const section of Object.keys(merged)) {
      if (parsed[section] && typeof parsed[section] === 'object') {
        Object.assign(merged[section], parsed[section]);
      }
    }
    return merged;
  } catch {
    return BANDS_DEFAULTS;
  }
}
