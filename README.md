# astra-infra-hook-agent

Astra Flow **Hook 工具运行时**（平台能力层 · L1）。

> 与业务架构分层对齐（ADR-010）：`.github/hooks/*.json` 是**运行时配置**（工程规范层，
> 仅声明事件绑定 + command 指向本子模块）；**本仓库是工具源码**（平台能力层），
> 可独立演进 / 测试 / 复用，与 `astra-infra-gateway` / `astra-infra-sdk` / `astra-infra-mcp` 形态一致。

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
│       ├── loop-guard.mjs      # PreToolUse 防循环（crypto sha256 + HOT_TOOLS 预过滤）
│       ├── decision-log.mjs    # 决策审计（async 后台评论）
│       └── session-issue-link.mjs  # 会话↔Issue 关联
├── test/                       # node:test evals + fixtures（双平台样例）
└── README.md
```

## 运行方式

```bash
# 作为 VS Code hook（.github/hooks/*.json）
./infra/hook-agent/bin/astra-hook.mjs loop-guard

# 本地测试
cd infra/hook-agent && node --test test/*.test.mjs
```

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
