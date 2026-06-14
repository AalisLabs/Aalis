# plugin-tools — 工具注册表

**包名**: `@aalis/plugin-tools`
**源码**: `packages/plugin-tools/src/index.ts`

## 概述

AI 可调用工具的中心注册表。提供 `tools` 服务，所有插件通过
`ctx.registerTool()` 注册工具，Agent / Commands 通过
`ctx.getService<ToolService>('tools')` 查询与执行。

与 `plugin-commands` 的 `CommandRegistry` 同属 "中心 Registry 模式"：
单一 `Map<name, Registered>` 存储、`register()` 返回 disposer、`setExecutionGuard()`
注入统一权限/安全检查钩子。与 LLM / Storage 的 "多 provider 路由" 模式不同——
所有工具都直接落到这个 Map，不需要 `getAllServices('tools')` 枚举。

## 插件声明

```typescript
export const name = '@aalis/plugin-tools';
export const subsystem = 'agent';
export const provides = ['tools'];
```

无配置项。无 inject 依赖（权限钩子由消费方通过 `setExecutionGuard()` 注入）。

## 主要能力

- **注册 / 注销**：`register(tool, pluginName)` → disposer；插件 dispose
  时按 `pluginName` 自动注销，避免遗留。
- **分组过滤**：`getDefinitions({ groups })` / `getSummaries({ groups })`
  按分组返回工具；未指定 `groups` 时**只**返回无分组的通用工具。
- **可见性覆盖**：工具默认可见性（`visibility: 'public' | 'restricted'`）由作者声明，
  owner 可经 authority 配置 `visibilityOverrides`（操作名 → public/restricted）临时覆盖，
  无需改插件。
- **执行守卫**：`setExecutionGuard(guard)` 注入统一钩子（典型为 plugin-authority
  的能力统一闸 / 受限能力临时委托确认）；所有 `execute()` 调用前过钩子。

## 相关插件

- 工具集生产方：[plugin-tool-system](plugin-tool-system.md)、
  [plugin-tool-browser](plugin-tool-browser.md)、
  [plugin-tool-code-runner](plugin-tool-code-runner.md)、
  [plugin-tool-math](plugin-tool-math.md)、
  [plugin-tool-search](plugin-tool-search.md)、
  [plugin-tool-onebot](plugin-tool-onebot.md)、
  [plugin-tool-session](plugin-tool-session.md) 等
- 消费方：[plugin-agent](plugin-agent.md)、[plugin-commands](plugin-commands.md)
- API 契约：[`@aalis/plugin-tools-api`](../api/plugin-tools-api.md)
