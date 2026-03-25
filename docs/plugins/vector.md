# Vector & Embedding 插件

文本向量化和向量存储的底层实现。被 plugin-memory-vector 等上层插件依赖。

---

## Embedding 插件

### plugin-embedding-ollama

基于本地 Ollama 服务的文本向量化。

**包名**: `@aalis/plugin-embedding-ollama`  
**源码**: `packages/plugin-embedding-ollama/src/index.ts`

#### 配置项

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `baseUrl` | string | `http://localhost:11434` | Ollama HTTP 地址 |
| `model` | select | `nomic-embed-text` | Embedding 模型（支持动态列表） |

#### API 版本自动检测

Ollama 有新旧两套 embedding API，插件**自动检测**：

| API | 端点 | 请求体 | 响应体 |
|---|---|---|---|
| 新版 | `POST /api/embed` | `{ model, input }` | `{ embeddings: number[][] }` |
| 旧版 | `POST /api/embeddings` | `{ model, prompt }` | `{ embedding: number[] }` |

检测逻辑：首次调用尝试新版 API，失败则回退到旧版，结果缓存到 `useNewApi` 字段。

#### 模型列表

通过 `GET /api/tags` 获取本地所有模型列表，供 WebUI 动态选项使用。

#### 连通性检查

启动时自动 embed 一次 `"ping"` 文本，失败仅 warn（不阻塞注册）。

---

### plugin-embedding-openai

基于 OpenAI Embeddings API 的文本向量化。

**包名**: `@aalis/plugin-embedding-openai`  
**源码**: `packages/plugin-embedding-openai/src/index.ts`

#### 配置项

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `apiKey` | string | (必填) | OpenAI API 密钥 |
| `baseUrl` | string | `https://api.openai.com` | API 端点 |
| `model` | select | `text-embedding-3-small` | Embedding 模型 |

#### API

```
POST {baseUrl}/v1/embeddings
{ model, input: text }
→ { data: [{ embedding: number[] }] }
```

---

## VectorStore 插件

### plugin-vectorstore-flat

纯 JSON 文件的平面向量存储，零依赖，适合小规模使用。

**包名**: `@aalis/plugin-vectorstore-flat`  
**源码**: `packages/plugin-vectorstore-flat/src/index.ts`

#### 配置项

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `path` | string | `data/vectorstore` | JSON 文件存储目录 |

#### 数据格式

存储文件 `vectors.json`，结构为：

```json
[
  { "vector": [0.1, 0.2, ...], "metadata": { "role": "user", "content": "...", ... } },
  ...
]
```

#### 向量计算

- **L2 归一化**: 所有向量在存储和查询时都经过 L2 归一化
- **余弦相似度**: 归一化后的点积即为余弦相似度
- **暴力搜索**: 全量计算，O(n) 复杂度，适合数据量 < 10000 的场景

```typescript
// 归一化
normalize(vec): vec / ||vec||₂

// 搜索
search(query, topK):
  q = normalize(query)
  scores = entries.map(e => dotProduct(q, e.vector))
  return topK(scores)
```

#### 持久化

- 使用 dirty 标记，仅在有变更时写入
- `dispose` 钩子自动保存
- `save()` 需由上层调用（如 memory-vector 在每次 add 后调用）

---

### plugin-vectorstore-lancedb

基于 LanceDB 的高性能向量存储，支持大规模数据。

**包名**: `@aalis/plugin-vectorstore-lancedb`  
**源码**: `packages/plugin-vectorstore-lancedb/src/index.ts`

#### 配置项

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `path` | string | `data/lancedb` | LanceDB 数据目录 |
| `tableName` | string | `vectors` | 向量表名称 |

#### 表结构

```
vector: number[]           -- 向量数据
metadata_json: string      -- JSON 编码的 metadata
```

首次 `add()` 时自动创建表，后续 `add()` 追加记录。

#### 搜索

```typescript
search(query, topK):
  results = table.search(query).limit(topK)
  // LanceDB 返回 L2 距离，转换为相似度：
  score = 1 - row._distance
```

#### 特性

| 特性 | Flat | LanceDB |
|---|---|---|
| 依赖 | 无 | @lancedb/lancedb |
| 持久化 | JSON 文件手动保存 | 自动持久化 |
| 搜索复杂度 | O(n) 暴力 | 索引加速 |
| 优先级 | 默认 | 10（更高） |
| 适用规模 | < 10K 条 | 大规模 |
| `save()` | 写入 JSON | 空操作 |
| `clear()` | 清空数组 | dropTable |

#### 优先级

LanceDB 注册时 `priority: 10`，高于 Flat 的默认优先级，当两者同时启用时 LanceDB 会被优先选择。
