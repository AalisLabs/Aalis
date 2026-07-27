# 结构化存储 — 缺位盘点与方案取舍

插件的**键值持久化**（`memory` 的 metadata）与**文件持久化**（`storage` 的 `pluginData:` 根）都已可用且在生产中承载数据；**查询、索引、事务这一层完全缺位** —— 不是某个实现有 bug，而是契约里就没有这个概念。

本篇不是缺陷清单，是结构性欠缺的盘点。以下每条均对着当前源码逐行核实（`file:line` 为 dev 分支 2026-07-28 状态），记录根因与方案取舍，避免后续重新调查。

## 现状：插件持久化只有两条路

### 一、`memory` 的 metadata KV

契约在 `packages/plugin-memory-api/src/index.ts:75-81`，四个方法：

```ts
saveMetadata?(namespace: string, key: string, data: Record<string, unknown>): Promise<void>;
getMetadata?(namespace: string, key: string): Promise<Record<string, unknown> | undefined>;
listMetadata?(namespace: string): Promise<Array<{ key: string; data: Record<string, unknown> }>>;
deleteMetadata?(namespace: string, key: string): Promise<void>;
```

写在 `MemoryService` 上（`ServiceTypeMap` 注册见同文件 `:108-110`），契约注释自述用途是「供会话管理等场景使用」（`:72`）—— **实况已远超这个意图**。

四个方法**全部可选**（`?`）。契约上可选、实况上三家后端全实现：`plugin-memory-inmemory/src/index.ts:236`、`plugin-memory-mongodb/src/index.ts:318`、`plugin-memory-sqlite/src/index.ts:431` 都 `provide('memory', ...)` 且都带完整 metadata 面。可选性今天只产生成本、不产生收益：每个消费方都得自己写守卫，写法还各不相同 —— `plugin-maimai/src/index.ts:138` 静默 `return null`、`plugin-memory-summary/src/index.ts:154-155` 直接 `throw`、`plugin-user-relation/src/store.ts:80-100` 定义了专门的 `UnsupportedMemoryError`、`plugin-todo-list/src/index.ts:39` 则是「有就存、没有就丢」。

sqlite 后端的落地形状（`plugin-memory-sqlite/src/index.ts:95-101`）：

```sql
CREATE TABLE IF NOT EXISTS metadata (
  namespace TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL,
  updatedAt TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (namespace, key)
);
```

`data` 是不透明 JSON 文本，主键只有 `(namespace, key)`。**载荷字段上不可能有索引**，这是缺口的物理根源。

**实际消费方 8 个**（另有 3 个后端实现方、1 个契约包，合计 12 个包引用该 API）：

| 插件 | 用法 | 关键位置 |
|---|---|---|
| `plugin-user-relation` | 关系图全部节点与边 | `src/store.ts` 全文件 |
| `plugin-user-profile` | 用户档案 + 事实条目 + 全局指令 | `src/index.ts:637-2441` |
| `plugin-session-manager` | 会话列表 | `src/index.ts:418-465` |
| `plugin-memory-summary` | 会话摘要 | `src/index.ts:167-195` |
| `plugin-todo-list` | 每会话 todo 数组 | `src/index.ts:37-50` |
| `plugin-maimai` | 用户绑定关系 | `src/index.ts:138-167` |
| `plugin-adapter-onebot` | 合并转发原文持久化 | `src/forward-expand.ts:143-155` |
| `plugin-media` | **读** user-profile 的档案 | `src/context.ts:52-54` |

### 二、`storage` 的 `pluginData:` 根

`plugin-storage-local` 默认注册 5 个根（两份同构声明：`configSchema.roots.default` 在 `src/index.ts:60-113`，`defaultConfig.roots` 在 `:146-197`）：

| 根名 | 本机路径 | 权限 |
|---|---|---|
| `workspace` | `workspace` | 读写删，`browsable` |
| `data` | `data` | 读写，**不可删** |
| `tmp` | `workspace/.tmp` | 读写删 |
| `pluginData` | `data/plugins` | 读写删 |
| `logs` | `data` | **只读** |

路径按 `resolve(process.cwd(), rootPath)` 解析（`:669`），即相对进程 cwd（项目根），不存在则 `mkdir -p`。每个根注册成独立服务 entry，`entryId = ${ctx.id}/${root.name}`（`:748-752`）。

接口是纯文件语义（`plugin-storage-api/src/index.ts:87-131`）：`list` / `stat` / `readFile` / `writeFile` / `rename` / `move?` / `mkdir?` / `delete` / `resolveLocalPath?` / `watch?`。没有任何查询原语。

**真正把 `pluginData:` 当自己数据目录用的只有 1 个插件**：`plugin-file-reader`（`src/index.ts:146` 定义 `pluginData:/file-reader`，`:226` 存文件本体、`:229` 存 `{id}.meta.json` 边车）。另外三处引用不是「用它存数据」：`plugin-webui-server/src/routes/uploaded-files.ts:21` 与 `plugin-webui-client/src/components/UploadedFilesDrawer.tsx:45` 是**读 file-reader 的目录树**（硬编码同一前缀）；`plugin-tool-system/src/index.ts:61` 只是把它列进「允许访问的存储根」多选项，`src/tools/http.ts:216` 提到它是为了**禁止**下载落到该根。

注意 `pluginData:` **没有按插件 id 自动隔离** —— `:748` 的 "scoped" 是按**根**分 entry，不是按插件。`pluginData:/file-reader` 这个子目录名纯属 file-reader 自觉的约定，任何拿到该根 entry 的插件都能读写其它插件的子目录。

## 缺口

### `saveMetadata` 被当结构化存储用，但它没有查询能力

`listMetadata(ns)` 在三家后端都是**全量拉取**，过滤全在调用方内存里做：

- sqlite `:338-342` —— `SELECT key, data FROM metadata WHERE namespace = ?` 后逐行 `JSON.parse`；
- mongodb `:239-242` —— `find({ namespace }).toArray()`；
- inmemory `:142-146` —— `[...ns.entries()]`。

没有 `where`、没有 `orderBy`、没有 `limit`、没有前缀扫描。凡是「按某字段找」的需求，唯一走法就是拉全表再在 JS 里 filter。

### 关系图每轮对话全表扫两次

**现象**：`user-relation` 的 prompt 注入在每次 direct / immediate 触发时都要把整个关系图从磁盘读出来解析一遍，且读两次。

**根因**：`plugin-user-relation/src/middleware.ts:51-64` 注册 `agent:prompt` 贡献 → `:85-89` 调 `service.traverseSubgraph(...)` → `src/service.ts:1676` `await this.store.loadAll()` → `src/store.ts:208` `listMetadata(RELATION_NAMESPACE)`，即**一次全 namespace 扫描 + 全量 `JSON.parse`**，然后靠 `key.startsWith('person:' | 'event:' | 'entity:' | 'edge:')` 在内存里分桶（`store.ts:214-220`）。同一次 build 里，`middleware.ts:251` 为了「全局热点」小节**再 `loadAll()` 一次**。

`RelationStore` 与 `RelationService` **一处缓存都没有**（`grep -n "cache" src/store.ts` 零命中，service 也无快照字段），两次调用是两次真实全表读。全插件共 **65 处 `loadAll()` 调用点**（`grep -rn '\.loadAll()' src` 得 67 行，除去 2 行注释），分布：`service.ts` 46、`commands.ts` 10、`actions.ts` 5、`store.ts` 3、`extractor.ts` 1、`middleware.ts` 1。

设计当初是有意的取舍，写在 `src/store.ts:16-17`：「不维护倒排索引：关系图体量预期 < 数千节点，全量加载完全可接受；真要扩到 10k+ 再加索引」。这个假设**已经被自己的代码打脸** —— `src/service.ts:3664-3665` 留着这行注释：

```
// 复用本函数顶部已加载的 snapshot，避免 scoreBetween 内部对每个 pair 重新
// store.loadAll()——N=300 时这一步会从 ~10s 膨胀到 ~100s。
```

**N=300 就已经是 10 秒到 100 秒的量级**，离「数千节点」还差一个数量级。修法是往调用链里手工穿 `_snapshot` 参数（`service.ts:1900` 的 `_snapshot` 内部优化选项、`:1939` 的 `opts._snapshot ?? await this.store.loadAll()`）—— 这是**在应用层手搓查询计划**，缺口的最直接证据。

**修法方向**：这一条不该在 `user-relation` 里修。手工传 snapshot 只能覆盖已知热点，65 个调用点靠人肉审查保证不退化不现实。正解是存储层给出带谓词的查询原语（至少是 key 前缀扫描 + 单字段索引），让「取某人的一跳邻居」是一次索引查询而非一次全表读。

**为什么现在不做**：见文末「方案取舍」—— 加什么原语取决于走哪个方向，先定方向再动手，否则就是往 `memory-api` 上贴补丁。

### 档案的全局回填也是全表扫（但默认关）

**现象**：群聊里注入「其他参与者」档案时可能触发一次 `user:profile` 全 namespace 扫描 + 内存排序。

**根因**：`plugin-user-profile/src/index.ts:1910` 同样注册 `agent:prompt` 贡献，`:2048-2057` 在候选人数不足时 `listMetadata(PROFILE_NS)` 拉全部档案，再按 `data.lastInteractionAt` 在内存里排序取前 N。这是典型的「本该 `ORDER BY lastInteractionAt DESC LIMIT n`」。

不同于关系图的是，这条**默认关闭** —— `allowGlobalBackfill` 默认 `false`（`:265`、`:525`），要用户显式打开。所以它今天不是热路径事故，是「一旦打开就是全表扫」的待爆点。

同插件的清理路径无条件全扫 + 逐 key 删：`:2146-2147`、`:2354-2355` 都是 `listMetadata` 拿全量再 `for` 循环 `deleteMetadata`。没有批量删除原语，也**没有事务** —— 中途失败就是删一半。

### 会话刷盘是 N 次独立写，没有原子性

**现象**：会话列表持久化是「把内存里全部会话逐条写一遍，再全表扫一遍删孤儿」。

**根因**：`plugin-session-manager/src/index.ts:448-465`。`markDirty()`（`:437-445`）用 1 秒 debounce 触发 `persist()`；`persist()` 里 `:453-455` 对 `this.sessions` 每个条目单独 `await saveMetadata`，`:458-465` 再 `listMetadata` 拉全表、对内存中不存在的 key 逐个 `deleteMetadata`。

`MemoryService` 里**没有任何事务/批量原语**（`grep -in "transaction\|batch\|txn" plugin-memory-api/src/index.ts` 零命中）。sqlite 后端自己内部用过 `db.transaction`（`:379`，`deleteMessagesByTimestamps` 专用），但没有把这个能力经契约暴露出去。后果：`persist()` 的写循环在任何一条上抛错，磁盘就停在半新半旧状态，且下一次 `persist()` 因为 `:450` 已经 `this.dirty = false` 而不会重试。

**修法方向**：契约缺的是「一次调用提交一批变更」的原语。这是三个后端都能实现的（sqlite 事务、mongodb `bulkWrite`、inmemory 天然原子），不需要引入新依赖。

### namespace 是无主的全局字符串空间

**现象**：`plugin-media` 直接读 `plugin-user-profile` 的私有存储，两边靠一个字面量对齐。

**根因**：`plugin-media/src/context.ts:21` 写死 `const USER_PROFILE_NAMESPACE = 'user:profile'`，`plugin-user-profile/src/index.ts:45` 写死 `const PROFILE_NS = 'user:profile'`。两处常量互不引用、无共享契约、无编译期关联。`user-profile` 改一次 namespace 或改一次档案 schema，`media` 静默降级（`context.ts:70-73` catch 后返回空串）。

`saveMetadata(namespace, ...)` 的 namespace 参数**不经任何门面 stamp**，谁都能传任何字符串。这与本项目在 events / services / hooks 三原语上一贯的「注册经闭包 `ctx.id` 的门面」纪律是**背离的** —— 那三处都做了 id-stamping，metadata 这条路没有。

**修法方向**：要么按 `ctx.id` 自动加前缀并另开显式的跨插件读取通道，要么把跨插件读取抬成正式契约（`user-profile` 导出一个 `getProfile` 服务，`media` 经 DI 拿）。后者与 `docs/` 里已记录的「避免污染共享契约」方向一致。

**为什么现在不做**：加前缀是**破坏性变更**（既有数据的 namespace 全变），得配迁移；而 `media → user-profile` 这一处走 DI 是局部修，可以独立于存储层方案先做。

### 无 TTL，无过期，无法收敛

**现象**：`onebot` 合并转发的完整原文永久堆在 metadata 表里。

**根因**：`plugin-adapter-onebot/src/forward-expand.ts:142-147` 每收到一条合并转发就 `saveMetadata(FORWARD_METADATA_NS, id, entry)`，`entry` 含完整 `fullText`。内存缓存那侧有 1 小时 TTL 与过期回收（`:137-141`），**持久化那侧一条清理路径都没有** —— 该文件只出现 `saveMetadata` 与 `getMetadata`，无 `listMetadata`、无 `deleteMetadata`。

契约里没有 TTL 概念，也没有「按 updatedAt 批量删」的原语。想清理只能全表扫 + 逐条删，而 `updatedAt` 列虽然存在（sqlite `:99`）却**不出现在 `listMetadata` 的返回结构里**（`memory-api:79` 只返回 `{ key, data }`），应用层根本拿不到它。

## 与 Koishi 兼容层的交汇

Koishi 生态的结构化存储是 `ctx.model.extend` + `ctx.database.get/set/create/upsert/remove/select`，底层是 minato ORM。同批 npm 市场扫描的实证数据（本仓库内无法复核，见同目录 [`koishi-compat.md`](./koishi-compat.md)）：4426 个 Koishi 包中 **11.8% 声明依赖 database**；下载量靠前的 114 个插件里 `ctx.model.extend` 命中 **25%**、`ctx.database.get` 命中 **26%**。也就是说，兼容层若不提供 database，能跑的插件砍掉四分之一。

**但兼容层不需要 Aalis 实现 minato。** 嵌入式方案是直接依赖 `@minatojs/driver-sqlite`（WASM 版，无原生编译），给它指一个沙盒内路径即可。Koishi 插件拿到的是货真价实的 minato，行为与上游一致，Aalis 侧零 ORM 代码。

所以**这两件事在实现上完全解耦**：兼容层的 database 需求由 minato 自己满足，不依赖 Aalis 有没有结构化存储；Aalis 自己的结构化存储需求（上一节六个缺口）也不因为兼容层引了 minato 就自动被满足 —— 那是给 Koishi 插件的沙盒，不是 Aalis 的公共设施。

两者唯一的交汇点是一个判断题：**既然进程里反正会有一个能用的嵌入式 ORM，Aalis 自己是不是也该用它。** 这是方案取舍里的一个变量，不是结论。

## 方案取舍（未决，待拍板）

以下三个方向互斥程度不同，代价各异。**均未决**，需要定方向后才能动手 —— 在此之前不要往 `memory-api` 上贴单点补丁，那只会让将来的迁移更贵。

先厘清一件事：**三个方向都不进 `@aalis/core`**。`memory-api` / `storage-api` 都是契约插件包，core 的零运行时依赖（`packages/core/package.json:28` `"dependencies": {}`）与环境无关约束在任何方向下都不受威胁。真正的分歧在两处：**契约包该多厚**，以及**「忒修斯之船」的可替换单元切在哪里**。

### 方向 A：扩 `memory` 契约，加查询能力

在现有四个方法旁边加谓词查询（`listMetadata(ns, { prefix, where, orderBy, limit })`）、批量提交、TTL / `updatedAt` 暴露。

- **代价**：三家后端都要跟进实现；查询能力一旦进契约就得定义语义（`where` 支持到什么程度？跨后端语义一致吗？），这是 ORM 的滑坡起点 —— 每加一个谓词都在往 `memory-api` 里塞一点 minato。
- **对可替换性的影响**：**抬高第三方 memory 后端的门槛**。今天写一个新 memory 后端的成本是「实现几个 KV 方法」，加查询后变成「实现一个查询引擎」。四个方法的可选性（`?`）本来是给这种情况留的口子，但可选性今天已经证明是纯成本（见上文八个消费方八种守卫写法）。
- **收益**：改动面最小，既有数据零迁移，六个缺口里的五个能直接解决。

### 方向 B：独立的 ORM 服务契约，后端可插拔

新开一个 `plugin-database-api` 契约（表定义 + 查询），实现可以是 minato-sqlite、可以是别的。`memory` 退回它本来的职责（消息历史），metadata 面标记废弃并迁移。

- **代价**：最大。要设计一套表契约、要写迁移（八个消费方全动，其中 `user-relation` 是 65 个调用点的重构）、要新增一个必装插件。
- **对极简内核的影响**：**这是最符合「万物皆插件」的形状** —— 结构化存储成为一个可替换的服务，而不是长在 memory 上的赘生物。但它也意味着 Aalis 多了一个「事实上必装」的基础设施插件，与「极简」的张力是真实的。
- **与 Koishi 兼容层的关系**：这是两者唯一可能合并的方向 —— 如果 minato 反正要进来，`plugin-database-minato` 可以同时服务两边。但要小心：**这会把 Aalis 的核心数据契约绑到 Koishi 生态的 ORM 上**，是一个长期方向性决定，不是省事的复用。

### 方向 C：不动契约，插件各自用 storage 存 sqlite 文件

`user-relation` 这类真有查询需求的插件自己 `resolveLocalPath('pluginData:/user-relation')` 开一个 sqlite。

- **代价**：每个插件自带一份 db 依赖与 schema 迁移代码；数据散在 N 个文件里，备份 / 清空 / 导出全部失去统一入口（今天 `/clear` 之类的编排至少还有 `memory:clear` 钩子这个汇流点）；`resolveLocalPath` 自己的文档就写明**它不是沙箱边界**（`plugin-storage-api/src/index.ts:83`、`:116-119`）。
- **对极简内核的影响**：内核与契约零改动，最「克制」。
- **但**：这实际上是**把结构化存储的缺位下放给每个插件作者**，等于宣布 Aalis 不提供这层能力。对单插件是可行的（`user-relation` 完全可以这么干且立刻见效），作为**全局答案则是弃权**。

### 需要拍板的问题

1. **Aalis 是否把「结构化存储」认作平台级能力**？认 → A 或 B；不认 → C，并明确写进插件作者文档。
2. 若认，**是扩既有契约（A）还是另起契约（B）**？取决于对「memory 该多厚」的判断。
3. **是否与 Koishi 兼容层共用一个 ORM 实现**？这个问题只在选 B 时才存在，且答案不必与 B 同时给出 —— 契约先立，实现可以先用简单的、之后再换。

在 1 定下来之前，`user-relation` 的性能问题**可以走 C 的局部版本**（插件内加一层进程内快照缓存 + 失效信号），这不预设任何方向，也不制造迁移债。

## 相关文档

- 服务契约：[`docs/services/memory.md`](../services/memory.md)、[`docs/services/storage.md`](../services/storage.md)
- URI 语法：[`docs/concepts/storage-uri-grammar.md`](../concepts/storage-uri-grammar.md)
- 兼容层：[`koishi-compat.md`](./koishi-compat.md)
