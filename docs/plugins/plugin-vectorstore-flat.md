# plugin-vectorstore-flat — 平面文件向量存储

**包名**: `@aalis/plugin-vectorstore-flat`  
**源码**: `packages/plugin-vectorstore-flat/src/index.ts`

## 概述

基于 JSON 文件的平面向量存储，适合轻量/开发场景。

## 插件声明

```typescript
meta.name = '@aalis/plugin-vectorstore-flat'
meta.provides = ['vectorstore']
meta.inject = {} // 无依赖
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `path` | string | `'data:/vectorstore'` | 存储目录：JSON 向量文件存储目录（storage URI）。也兼容旧格式 “data/vectorstore”。 |

## 特性

- 向量归一化后写入 `vectors.json`
- 搜索时使用余弦相似度（归一化后等价于点积）排序取 topK
- 支持 `add` / `search` / `clear` / `save` / `size`
- dispose 时自动保存
- 适合开发调试和小规模数据，大规模场景建议使用 plugin-vectorstore-lancedb
