/**
 * error-class.mjs — 工具错误分类（#1020 FR-007/FR-012，R3 决策）
 *
 * 职责：PostToolUse 事件中，对 toolResponse 做文本模式匹配，判定错误类别
 * （permission / transient / rate-limit），供 loop-guard 权限即停逻辑消费。
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
  PERMISSION: 'permission',   // 权限类：首次失败即停，重试直接拦截（FR-007/008）
  RATE_LIMIT: 'rate-limit',   // 限流类：需退避，不进入重试计数（FR-007）
  TRANSIENT: 'transient',     // 瞬时类：允许有限重试（FR-007）
};

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
 * @param {string} [configPath] - 显式路径（测试注入用）；默认 config/error-classes.yaml
 * @returns {object|null} { permission: RegExp[], transient: RegExp[], rateLimit: RegExp[] }
 */
export function loadErrorClasses(configPath) {
  const path = configPath || defaultConfigPath();
  if (cachedConfig && cachedPath === path) return cachedConfig;
  if (!existsSync(path)) return null;
  try {
    const parsed = parseErrorClassesYaml(readFileSync(path, 'utf8'));
    if (!parsed || !parsed['error-classes']) return null;
    const classes = parsed['error-classes'];
    const config = {
      permission: compilePatterns(classes['permission']?.patterns),
      transient: compilePatterns(classes['transient']?.patterns),
      rateLimit: compilePatterns(classes['rate-limit']?.patterns),
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
 * 判定顺序：permission → rate-limit → transient（权限最优先——误归 transient
 * 会导致权限错误被重试，安全代价最高）。无匹配 → transient（fail-open）。
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
    if (!cfg) return ERROR_CLASSES.TRANSIENT; // 配置缺失 → fail-open
    if (cfg.permission.some((re) => re.test(text))) return ERROR_CLASSES.PERMISSION;
    if (cfg.rateLimit.some((re) => re.test(text))) return ERROR_CLASSES.RATE_LIMIT;
    return ERROR_CLASSES.TRANSIENT; // 无匹配 → 瞬时（fail-open，不误拦）
  } catch {
    return ERROR_CLASSES.TRANSIENT; // 任何异常 → 瞬时（fail-open）
  }
}
