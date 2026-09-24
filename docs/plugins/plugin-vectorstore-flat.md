# plugin-vectorstore-flat — 平面文件向量存储

**包名**: `@aalis/plugin-vectorstore-flat`  
**源码**: `packages/plugin-vectorstore-flat/src/index.ts`

## 概述

基于 JSON 文件的平面向量存储，适合轻量/开发场景。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-vectorstore-flat',
  provides: [vectorstore],
  uses: {
    storage,
    provide,
    config,
    logger,
    lifecycle,
  },
  apply(caps) { /* 见源码 */ },
});
```

向量全部存在 storage 上的 `vectors.json` 里，没有 storage 既读不出也写不进，故 storage 是必需依赖。关停以激活为单位分 drain / close：本插件对 storage 是普通依赖，消费者整个 close 完提供者才 drain，因此 `onDispose` 里 `await store.save()` 时 storage 仍在。单独禁用或热重载 storage 时本插件作为正在用它的 required 下游并入同一批先关，保存同样成立。落盘由调用方调用 `save()` 触发（见 api-vectorstore 契约），dispose 时的保存是兜底冲刷。

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `path` | string | `'data:/vectorstore'` | 存储目录：JSON 向量文件存储目录（storage URI）。也兼容旧格式 “data/vectorstore”。 |

## 特性

- 向量归一化后写入 `vectors.json`
- 搜索时使用余弦相似度（归一化后等价于点积）排序取 topK
- 支持 `add` / `search` / `clear` / `save` / `size`
- dispose 时自动保存，并 `await` 落盘完成后才结束拆卸（普通依赖：本插件 close 完 storage 才 drain；必须 await，void 化会让停机时最后一批向量来不及落盘）
- 数据文件损坏（解析失败）或内容不是数组时告警并按空库启动，不影响后续写入
- 适合开发调试和小规模数据，大规模场景建议使用 plugin-vectorstore-lancedb
