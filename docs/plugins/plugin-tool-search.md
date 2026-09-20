# plugin-tool-search — 工具搜索层

**包名**: `@aalis/plugin-tool-search`  
**源码**: `packages/plugin-tool-search/src/index.ts`

## 概述

当本轮请求携带的工具数超过 `maxDirectTools` 时，将工具列表替换为 `search_tools`、直出工具与已发现工具：其余工具需 LLM 先调用 `search_tools` 取得定义后才能使用，以减少工具定义占用的 token。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-tool-search',
  uses: {
    tools: optional(tools),
    hooks,
    logger,
    config,
  },
  apply(caps) { /* 见源码 */ },
});
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 启用工具搜索层：关闭后所有工具将直接发送给 LLM，不经过搜索层 |
| `showToolNames` | boolean | `true` | 展示工具名称列表：开启后，系统提示中会附带所有可用工具的名称列表（不含说明），模型需要调用 search_tools 查询具体用法后才能使用对应工具。关闭后模型只看到 search_tools，需要先搜索才能发现工具。 |
| `maxDirectTools` | number | `5` | 直传阈值：当注册的工具总数不超过此值时，跳过搜索层，直接将全部工具发送给 LLM |
| `maxSearchResults` | number | `5` | 搜索结果上限：单次搜索返回的最大工具数量，0 表示不限制 |
| `alwaysDirectTools` | multiselect | `[]` | 直出工具名单：即使启用工具搜索层，也始终直接暴露这些工具的完整定义。填写工具名，如 web_search。 |
| `maxDiscoveredKeep` | number | `20` | 已发现工具队列上限：从消息历史推断出的“已发现工具”最多保留 N 个（按最近使用时间倒序保留，0 = 不限）。避免长会话里 discovered 集合无限膨胀，使搜索层失去瘦身价值。 |

## 工作原理

通过 `agent:llm:before` 中间件整体替换 `data.tools`（每轮迭代都会重新计算，结果与其它 handler 的顺序无关）：

1. **检查阈值**: 如果本轮请求中的工具数（不含 `search_tools` 自身）≤ `maxDirectTools`，跳过搜索层，原样传递所有工具
2. **应用直出名单**: `alwaysDirectTools` 中的工具只要出现在本轮工具列表里，就保留完整定义；名单中未注册或当前不可用的工具名会记录一次警告日志
3. **替换工具列表**: 将 `data.tools` 替换为 `search_tools` 定义 + 直出工具定义 + 已发现工具定义
4. **追踪已发现工具**: 从消息历史中提取已发现工具（`search_tools` 结果中返回过的工具，以及实际调用过且收到了结果的工具），并入会话级的已发现工具集（进程内存，按最近使用保留最多 `maxDiscoveredKeep` 个，上下文裁剪后仍保留）
5. **名称清单（`showToolNames`）**: 在 `search_tools` 的工具描述中附上其余工具的名称清单，仅供构造搜索关键词；描述中明确要求先搜索拿到参数定义再调用

另注册 `memory:clear` 中间件，清除记忆时一并清空对应会话（scope 为 `all` 时清空全部）的已发现工具集。

示例：

```yaml
plugins:
  "@aalis/plugin-tool-search":
    enabled: true
    showToolNames: true
    maxDirectTools: 5
    maxSearchResults: 10
    alwaysDirectTools:
      - web_search
```

### `search_tools` 工具

参数: `{ query: string; limit?: number; offset?: number }`。`query` 为空字符串时匹配全部工具；`limit` 缺省时取 `maxSearchResults` 的值（配置为 0 时不限数量）；`offset` 用于翻页。

按空白切分关键词，对工具名与描述做不区分大小写的子串匹配（任一关键词命中即可），结果按调用时的启用分组过滤。返回 JSON：`found`、`tools`（含 name、description、parameters 完整定义）、结果被截断时的 `pagination`、同组其它工具名 `related`、以及 `hint`。返回的工具会记入已发现集，后续轮次可以直接调用。
