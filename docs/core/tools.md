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
  visibility?: CapabilityVisibility;  // 'public' | 'restricted'（默认 public）
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
  visibility: 'public',
});
```

## 执行流程

```
tools.execute(name, args, callCtx)
  │
  ├─ 查找工具（解析有效可见性）
  ├─ 执行守卫: authority.authorize() —— 逐能力裁决 deny > owner > public > granted
  ├─ 若命中未授予的 restricted 能力:
  │     authority.requestAccess() → 临时委托（白名单 / 会话授予 / 确认回调）
  └─ 调用 handler(args, callCtx) → 返回字符串结果
```

## 查询方法

```typescript
tools.getDefinitions()    // 获取所有工具定义（发给 LLM）
tools.getSummaries()      // 获取摘要（名称、描述、分组）
tools.getAll()            // 获取详细信息（含插件名、可见性、分组）
```

## 可见性覆盖

与指令系统类似，owner 可通过 authority 配置覆盖单条工具的默认可见性，无需改插件声明：

```yaml
visibilityOverrides:
  exec: restricted
```

## 生命周期

- `register()` 返回 dispose 函数，调用后移除工具
- `unregisterByPlugin(pluginName)` — 插件卸载时批量清理
