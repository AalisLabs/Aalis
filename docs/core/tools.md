# ToolRegistry — 工具注册表

管理 AI 工具的注册、权限检查和执行。

**源码**: `packages/core/src/tools.ts`

## 工具定义

工具定义遵循 OpenAI function calling 格式：

```typescript
interface RegisteredTool {
  definition: ToolDefinition;   // OpenAI 格式的工具定义
  handler: (args: Record<string, unknown>, ctx?: ToolCallContext) => Promise<string>;
  pluginName: string;           // 注册该工具的插件名
  safety?: 'safe' | 'dangerous';
  authority?: number;           // 最低权限等级
}
```

## 注册工具

```typescript
import { useToolService } from '@aalis/plugin-tools-api';

const tools = useToolService(ctx);
const dispose = tools.register({
  definition: {
    type: 'function',
    function: {
      name: 'my_tool',
      strict: true,
      description: '工具描述',
      parameters: {
        type: 'object',
        properties: { input: { type: 'string' } },
        required: ['input'],
        additionalProperties: false,
      },
    },
  },
  handler: async (args) => `结果: ${args.input}`,
  safety: 'safe',
  authority: 0,
});
```

## 执行流程

```
tools.execute(name, args, callCtx)
  │
  ├─ 查找工具（含覆盖的权限/安全等级）
  ├─ 权限检查: authority.getAuthority() ≥ 工具要求
  ├─ 如果 safety='dangerous':
  │     authority.confirmDangerous() → 交互式确认
  └─ 调用 handler(args, callCtx) → 返回字符串结果
```

## 查询方法

```typescript
tools.getDefinitions()    // 获取所有工具定义（发给 LLM）
tools.getSummaries()      // 获取摘要（名称、描述、权限）
tools.getAll()            // 获取详细信息（含插件名、是否被覆盖）
```

## 覆盖系统

与指令系统类似，支持通过配置覆盖工具的权限和安全等级：

```yaml
toolOverrides:
  exec:
    authority: 5
    safety: dangerous
```

## 生命周期

- `register()` 返回 dispose 函数，调用后移除工具
- `unregisterByPlugin(pluginName)` — 插件卸载时批量清理
