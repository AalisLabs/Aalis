# Memory 插件

三个记忆插件分别处理短期对话记忆（SQLite / MongoDB）和长期语义记忆（Vector Memory）。

---

## plugin-memory-sqlite

基于 better-sqlite3 的本地记忆存储，推荐用于单机部署。

**包名**: `@aalis/plugin-memory-sqlite`  
**源码**: `packages/plugin-memory-sqlite/src/index.ts`

### 配置项

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `path` | string | `data/aalis.db` | 数据库文件路径，相对于项目根目录 |

### 数据库 Schema

```sql
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sessionId TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  toolCalls TEXT,           -- JSON string
  toolCallId TEXT,
  name TEXT,
  timestamp INTEGER NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_session
  ON messages(sessionId, timestamp);
```

### 特性

- **WAL 模式**: `pragma journal_mode = WAL`，提升并发读写性能
- **优先级**: `priority: 10`，高于默认的 InMemoryFallback
- **dispose 钩子**: 在插件卸载时关闭数据库连接

### /clear 指令

由 SQLite 记忆插件注册：
1. 清空指定 sessionId 的所有消息
2. 如果 vectorstore 服务可用，同时清空向量记忆
3. 返回确认文本

### MemoryService 方法

| 方法 | 说明 |
|---|---|
| `saveMessage(sessionId, message)` | INSERT 一条消息记录 |
| `getHistory(sessionId, limit=50)` | 取最近 N 条消息（子查询 DESC + 外层 ASC） |
| `clearSession(sessionId)` | DELETE 该会话所有消息 |

---

## plugin-memory-mongodb

基于 MongoDB 的分布式记忆存储，适用于多实例或云部署。

**包名**: `@aalis/plugin-memory-mongodb`  
**源码**: `packages/plugin-memory-mongodb/src/index.ts`

### 配置项

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `uri` | string | `mongodb://localhost:27017` | MongoDB 连接字符串 |
| `database` | string | `aalis` | 数据库名 |
| `collection` | string | `messages` | 集合名 |
| `connectTimeoutMs` | number | 5000 | 连接超时 |

### 索引

```javascript
{ sessionId: 1, timestamp: 1 }
```

### 文档结构

```typescript
interface MessageDocument {
  sessionId: string;
  role: string;
  content: string | null;
  toolCalls?: unknown[];
  toolCallId?: string;
  name?: string;
  timestamp: number;
  createdAt: Date;
}
```

### 特性

- **异步连接**: `apply()` 为 async，连接失败直接 throw
- **自动索引**: 启动时自动创建复合索引
- **dispose 钩子**: 关闭 MongoClient

---

## plugin-memory-vector

语义记忆插件——将对话消息向量化存储，在 LLM 调用前自动检索相关历史注入上下文。

**包名**: `@aalis/plugin-memory-vector`  
**源码**: `packages/plugin-memory-vector/src/index.ts`

### 依赖

```typescript
provides = ['semanticMemory']
inject = { required: ['vectorstore', 'embedding'] }
```

### 配置项

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `search.topK` | number | 5 | 语义搜索返回的最大记忆条数 |
| `search.timeWeight` | number | 0.3 | 0=纯语义，1=纯时间近因 |

### 工作原理

#### 1. 消息索引

监听 `message:received` 和 `message:send` 事件，自动将消息内容向量化并存入 vectorstore：

```
收到消息 → embed(content) → store.add(vector, metadata) → store.save()
```

metadata 包含 `{ role, content, sessionId, timestamp }`。

#### 2. 检索与注入

注册 `llm-call:before` 中间件（优先级 50），在每次 LLM 调用前：

```
取最后一条 user 消息
    → embed(content)
    → store.search(vector, topK × 3)  // 取 3 倍候选
    → 时间加权重排
    → 取 topK 结果
    → 过滤当前会话重复
    → 注入 system 消息到 messages 列表
```

#### 3. 时间加权重排公式

$$\text{finalScore} = (1 - \text{timeWeight}) \times \text{semanticScore} + \text{timeWeight} \times e^{-0.1 \times \text{daysSince}}$$

- `semanticScore`: 向量相似度得分（0-1）
- `daysSince`: 消息距今天数
- `timeWeight = 0.3` 时：70% 语义 + 30% 时间近因

#### 4. 注入位置

检索到的记忆以 system 消息形式注入到**首条非 system 消息之前**：

```
[system] 主提示词
[system] 从长期记忆中检索到的相关历史片段...  ← 注入位置
[user] 历史消息
[assistant] ...
[user] 当前消息
```

#### 5. 去重

已在当前 messages 中出现的 content 会被过滤掉，避免重复信息。
