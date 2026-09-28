/**
 * error-class.mjs — 工具错误分类（#1020 FR-007/FR-012，R3 决策；#1063 P1 强/弱模式）
 *
 * 职责：PostToolUse 事件中，对 toolResponse 做文本模式匹配，判定错误类别
 * （permission / transient / rate-limit），供 loop-guard 权限即停逻辑消费。
 *
 * #1063 P1 修复（熔断误杀）：permission 判定引入强/弱两级模式——
 *   - 强模式（strong_patterns）：错误响应形态（HTTP 状态码 \b40[13]\b、
 *     Error:.*permission denied 等错误前缀）才触发 PERMISSION（置位 permissionFlag）
 *   - 弱模式（weak_patterns）：裸关键词（正文含 Forbidden/permission denied 等），
 *     仅返回 WEAK_PERMISSION（审计日志），不置位——业务文本不再误杀
 *   - 内置兜底：状态码正则 \b40[13]\b 在配置缺失/全弱模式下始终生效（防真实 403 漏判）
 *
 * 设计约束：
 * - 纯函数：加载配置与判定分离，便于测试（coverage 100% 基线）
 * - fail-open：分类失败（配置缺失/解析失败/无匹配）一律归 transient（可重试），
 *   绝不因分类异常误拦正常调用（spec Risk 2 缓解）
 * - 零依赖：配置解析复用 bands.yaml 手工解析器模式（两层嵌套 key: value），
 *   模式列表用逗号分隔标量（parseSimpleYaml 不支持 YAML 列表语法）
 * - 时延预算：模式匹配为正则预编译 + 短路返回，<1ms
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 错误类别枚举（与 error-classes.yaml 分类节一一对应） */
export const ERROR_CLASSES = {
  PERMISSION: 'permission',   // 权限类（强模式命中）：首次失败即停，重试直接拦截（FR-007/008）
  WEAK_PERMISSION: 'weak-permission', // 权限弱模式命中（#1063）：裸关键词，仅审计，不置位
  RATE_LIMIT: 'rate-limit',   // 限流类：需退避，不进入重试计数（FR-007）
  TRANSIENT: 'transient',     // 瞬时类：允许有限重试（FR-007）
};

/**
 * 内置强模式兜底正则（#1063 FR-101/plan T1）：权限错误的**错误响应**形态。
 * 配置缺失/全弱模式/配置漂移时始终生效，防真实权限错误漏判（安全底线）。
 *
 * 关键设计（三轮活体实证 + 原 spec 回归约束）：
 *   1. 不能是裸 \b40[13]\b——正文提及 "403"（Issue 评论/文档举例）即误命中。
 *   2. 不能是 "HTTP 401" 前缀——终端回显测试输出（断言文本含 "HTTP 401"）误命中。
 *   3. 必须保留原 spec 权限语义（error-class.test.mjs EC1/EC8 回归）：
 *      - `Error: 403` / `error code 403`（错误前缀 + 状态码）
 *      - `401 Unauthorized` / `403 Forbidden`（状态码 + 权限词）
 *      - `403 Resource not accessible`（状态码 + 错误语义——EC8 #942 实证）
 *      - `permission denied` / `access denied`（完整短语——几乎只出现在错误响应）
 *      - `Forbidden for ...` / `Unauthorized by ...`（权限词 + 错误语义介词后缀）
 *   4. 纯业务文本（裸 "403"/"Forbidden" 出现在正文/标题）→ 弱模式，不误杀。
 */
const BUILTIN_STRONG_RE =
  /(?:^|[\s:(])(?:Error|error code|message)\s*[: ]\s*40[13]|40[13]\s+(?:Forbidden|Unauthorized|error|Resource\s+not\s+accessible)|(?:permission|access)\s+denied|\bForbidden\s+(?:for|by|to|when|in|on)\b|\bUnauthorized\s+(?:for|by|to|when|in|on)\b/i;

/** 配置文件默认路径（config/error-classes.yaml，与 bands.yaml 同级） */
function defaultConfigPath() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'error-classes.yaml');
}

/**
 * 极简 YAML 解析（两层嵌套 mapping + 标量值；模式列表用逗号分隔字符串）。
 * 与 config.mjs parseSimpleYaml 同构——独立实现避免跨模块耦合（error-class
 * 需在无 bands 依赖下独立测试）。
 * @param {string} text
 * @returns {object|null} 解析失败返回 null（调用方 fail-open 兜底）
 */
export function parseErrorClassesYaml(text) {
  try {
    const root = {};
    let section = null;
    let subsection = null;
    for (const line of text.split('\n')) {
      const noComment = line.split('#')[0].replace(/\s+$/, '');
      if (!noComment.trim()) continue;
      const indent = noComment.length - noComment.trimStart().length;
      const content = noComment.trim();
      const kv = content.match(/^([^:]+):\s*(.*)$/);
      if (!kv) continue;
      const key = kv[1].trim();
      const value = kv[2].trim();
      if (indent === 0) {
        section = key;
        root[section] = {};
        subsection = null;
      } else if (indent > 0 && section) {
        if (value === '') {
          subsection = key;
          root[section][subsection] = {};
        } else if (subsection) {
          root[section][subsection][key] = value;
        } else {
          root[section][key] = value;
        }
      }
    }
    return root;
  } catch {
    return null;
  }
}

/** 逗号分隔模式字符串 → 正则数组（预编译，i 大小写不敏感） */
function compilePatterns(patternStr) {
  if (!patternStr || typeof patternStr !== 'string') return [];
  return patternStr
    .split(',')
    .map((p) => p.trim())
    // 去除 YAML 值残留引号（parseErrorClassesYaml 不做去引号，此处兜底）
    .map((p) => p.replace(/^["']|["']$/g, '').trim())
    .filter(Boolean)
    .map((p) => {
      try {
        return new RegExp(p, 'i');
      } catch {
        return null; // 非法模式跳过（配置错误不炸运行时）
      }
    })
    .filter(Boolean);
}

/** 分类配置内存缓存（spawn-per-call 模型下进程生命周期内单次加载） */
let cachedConfig = null;
let cachedPath = null;

/**
 * 加载错误分类配置（带缓存；文件缺失/解析失败返回 null → 调用方 fail-open）。
 * #1063 重构：permission 节支持 strong_patterns/weak_patterns 两级；
 * 旧配置（patterns 键）按弱模式处理（消除误杀优先，真实错误由内置强模式兜底）。
 * @param {string} [configPath] - 显式路径（测试注入用）；默认 config/error-classes.yaml
 * @returns {object|null} {
 *   permission: RegExp[],      // 强模式（触发置位）+ 内置兜底
 *   weakPermission: RegExp[],  // 弱模式（仅审计，不置位）
 *   transient: RegExp[], rateLimit: RegExp[]
 * }
 */
export function loadErrorClasses(configPath) {
  const path = configPath || defaultConfigPath();
  if (cachedConfig && cachedPath === path) return cachedConfig;
  if (!existsSync(path)) return null;
  try {
    const parsed = parseErrorClassesYaml(readFileSync(path, 'utf8'));
    if (!parsed || !parsed['error-classes']) return null;
    const classes = parsed['error-classes'];
    // patterns 可能是嵌套对象（parseErrorClassesYaml 将 "key: value" 中含冒号的
    // 值误判为 subsection——正则片段含 "403:" 类形态时）或字符串；两种形态都取
    // 指定键的标量值。compilePatterns 内部对非字符串返回空数组（fail-open）。
    const extractPatterns = (node, key) => {
      if (typeof node === 'string') return node; // 整节是字符串（旧形态）
      if (node && typeof node === 'object') {
        // 新形态：strong_patterns/weak_patterns 子键
        if (typeof node[key] === 'string') return node[key];
        // 兼容形态：整节下直接挂 patterns（旧结构）
        if (key === 'patterns' && typeof node.patterns === 'string') return node.patterns;
      }
      return '';
    };
    const permNode = classes['permission'];
    // #1063：强/弱两级模式。强模式 = 显式 strong_patterns + 内置兜底；
    // 旧配置（仅 patterns）→ 该 patterns 归弱模式（不置位），内置兜底保证真实 403 仍即停。
    const strongPatterns = extractPatterns(permNode, 'strong_patterns');
    const weakPatterns = extractPatterns(permNode, 'weak_patterns') || extractPatterns(permNode, 'patterns');
    const config = {
      permission: [BUILTIN_STRONG_RE, ...compilePatterns(strongPatterns)],
      weakPermission: compilePatterns(weakPatterns),
      transient: compilePatterns(extractPatterns(classes['transient'], 'patterns')),
      rateLimit: compilePatterns(extractPatterns(classes['rate-limit'], 'patterns')),
    };
    cachedConfig = config;
    cachedPath = path;
    return config;
  } catch {
    return null;
  }
}

/** 清空缓存（测试隔离用） */
export function clearErrorClassesCache() {
  cachedConfig = null;
  cachedPath = null;
}

/**
 * 判定 toolResponse 的错误类别。
 *
 * #1063 判定顺序：强模式 permission → rate-limit → transient → 弱模式 weak-permission。
 *   - 强模式（含内置兜底 \b40[13]\b）命中 → PERMISSION（置位，权限即停）
 *   - rate-limit 命中 → RATE_LIMIT（退避）
 *   - 弱模式命中（裸关键词，无错误形态）→ WEAK_PERMISSION（仅审计，不置位）
 *   - 无匹配 → TRANSIENT（fail-open，不误拦）
 * 弱模式放最后：不覆盖更严重的分类（真实错误形态优先于业务文本关键词）。
 *
 * @param {string|object} toolResponse - PostToolUse 事件的工具执行结果
 * @param {object} [config] - 显式配置（测试注入用）；缺省时 loadErrorClasses()
 * @returns {string} ERROR_CLASSES 之一（永不抛错）
 */
export function classifyError(toolResponse, config) {
  try {
    const text = typeof toolResponse === 'string'
      ? toolResponse
      : JSON.stringify(toolResponse ?? '');
    if (!text) return ERROR_CLASSES.TRANSIENT;
    const cfg = config || loadErrorClasses();
    if (!cfg) return ERROR_CLASSES.TRANSIENT; // 配置缺失 → fail-open（内置兜底不适用，见 loadErrorClasses）
    if (cfg.permission.some((re) => re.test(text))) return ERROR_CLASSES.PERMISSION;
    if (cfg.rateLimit.some((re) => re.test(text))) return ERROR_CLASSES.RATE_LIMIT;
    if (cfg.weakPermission.some((re) => re.test(text))) return ERROR_CLASSES.WEAK_PERMISSION;
    return ERROR_CLASSES.TRANSIENT; // 无匹配 → 瞬时（fail-open，不误拦）
  } catch {
    return ERROR_CLASSES.TRANSIENT; // 任何异常 → 瞬时（fail-open）
  }
}
