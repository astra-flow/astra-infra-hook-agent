# astra-infra-hook-agent

Astra Flow **Hook 工具运行时**（平台能力层 · L1）。

> 与业务架构分层对齐（ADR-010）：`.github/hooks/*.json` 是**运行时配置**（工程规范层，
> 仅声明事件绑定 + command 指向本子模块）；**本仓库是工具源码**（平台能力层），
> 可独立演进 / 测试 / 复用，与 `astra-infra-gateway` / `astra-infra-sdk` / `astra-infra-mcp` 形态一致。

## 安装

### 前置条件

- **Node.js >= 18**（ESM 支持，仅用内置模块，无需 `npm install`）
- git submodule 链已初始化（见下）

### 步骤

```bash
# 1. 克隆主仓后，初始化 submodule 链（astra → infra → hook-agent）
git submodule update --init infra
cd infra && git submodule update --init hook-agent && cd ..

# 2. 赋予入口可执行权限（submodule 检出后通常已保留，保险起见执行一次）
chmod +x infra/hook-agent/bin/astra-hook.mjs

# 3. 验证安装（冒烟测试：应输出 allow 决策 JSON）
echo '{"sessionId":"smoke","toolName":"create_file","toolInput":{"filePath":"/tmp/x"},"hookEventName":"PreToolUse"}' \
  | ./infra/hook-agent/bin/astra-hook.mjs loop-guard
# 期望输出：{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow",...}}
```

### 验证 hook 已生效

在 VS Code 中开启 Copilot 会话，任意触发一次工具调用（如读文件）：

- `~/.astra/hooks/loop-guard/<sessionId>.json` 出现状态文件 → loop-guard 已生效
- `memories/session/issue-link.md` 追加记录 → session-issue-link 已生效

### 排障

| 现象 | 原因 | 处理 |
| ------ | ------ | ------ |
| 工具调用被莫名 deny | submodule 未初始化，command 指向空目录（fail-closed） | 执行步骤 1 |
| hook 无任何反应 | `.github/hooks/*.json` 未被 VS Code 加载（hooks 为 Preview 功能） | 检查 VS Code 版本与 hooks 开关 |
| decision-log 不评论 | gh 未登录或 prompt 无决策关键词 | `gh auth status` 检查；确认 prompt 含 `Approved`/`驳回` 等关键词 + `#Issue号` |

## 使用前提

Hook 可用性前置条件（D10）：`infra/hook-agent` submodule 必须已初始化。

```bash
git submodule update --init infra
```

> ⚠️ 未初始化时 `.github/hooks/*.json` 的 command 会指向空目录，导致 VS Code
> PreToolUse hook 失败 → **fail-closed（deny 工具调用）**。请确保先初始化。

## 目录结构

```
infra/hook-agent/
├── package.json                # node 模块声明（type: module）+ scripts.test
├── bin/
│   └── astra-hook.mjs          # 可执行入口（VS Code command 指向）
├── src/
│   ├── runtime.mjs             # 统一入口：读 stdin → 归一化 → 校验 → 分发 → 输出决策（fail-open）
│   ├── lib/
│   │   ├── normalize.mjs       # 平台字段归一化（snake_case → camelCase，CP-04）
│   │   ├── decision.mjs        # 决策输出构造（allow/deny/ask + reason）
│   │   ├── state.mjs           # 状态存储（~/.astra/hooks/ + 原子写 + 文件锁，D4/D6）
│   │   ├── config.mjs          # hook 元数据 schema（事件/超时/平台，CP-02）
│   │   └── validate.mjs        # 输入白名单校验 + 路径防护（CP-05）
│   └── hooks/
│       ├── loop-guard.mjs      # PreToolUse/PostToolUse 防循环（指纹去重 + 同工具计数苗头提醒 + 兜底第四轨道 + 错误分类权限即停，#1020）
│       ├── decision-log.mjs    # 决策审计（async 后台评论）
│       └── session-issue-link.mjs  # 会话↔Issue 关联
├── test/                       # node:test evals + fixtures（双平台样例）
└── README.md
```

## 运行方式

```bash
# 作为 VS Code hook（.github/hooks/*.json）
./infra/hook-agent/bin/astra-hook.mjs loop-guard

# 本地测试（evals）
cd infra/hook-agent && node --test test/*.test.mjs
```

## evals 说明

`test/` 下的 evals 是**行为验证测试**（非 mock 风格单元测试）：直接以 hook 协议的
stdin JSON 驱动 `run()`，断言输出的决策 JSON。覆盖 fail-open 语义、双平台归一化、
防循环拦截、安全脱敏等验收点（详见 `test/*.test.mjs` 内注释）。

## Hook 配置（工程规范层）

`.github/hooks/*.json` 仅存 VS Code 执行配置，例如：

```json
{
  "hooks": {
    "PreToolUse": [
      { "type": "command", "command": "./infra/hook-agent/bin/astra-hook.mjs loop-guard", "timeout": 5 }
    ]
  }
}
```

## 安全基线（CP-05）

- 输入白名单校验：非法结构/超长 prompt → fail-open（不阻塞）
- 路径防护：拒绝 `..` 穿越、NUL 字节
- 任何异常 → fail-open（continue），**绝不误伤正常工具调用**（VS Code fail-closed 约束的镜像）

## 关键平台约束

VS Code PreToolUse command hook 崩溃/非零退出 → 默认 deny（fail-closed）。
本运行时**自身保证 fail-open**：任何异常输出 continue 决策。

---

*关联：Issue #899（Epic）/ #900（Spike）/ ADR-014（Agent Hooks 统一运行时架构）*
