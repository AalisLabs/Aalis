# 服务持久化与重载语义参考

本文档梳理 Aalis 内置 / 一方插件提供的关键服务在 `App.reloadPlugin(name)`、
`recompute(reason)`、整进程 `restart()` 三种生命周期事件下的状态保持情况，供
插件作者与运维人员判断"我能不能热重载这个插件"。

## 概念

- **进程内态（in-memory）**：仅存于运行时内存，重启即丢。bounce 时若服务
  归属的插件被重新 apply，其内存态会重建为空。
- **磁盘 / DB 态（persistent）**：通过 storage 服务、SQLite / MongoDB / 文件
  落盘，重建后会从磁盘读回。
- **bounce-safe**：服务所属插件被 `App.reloadPlugin` 重新激活后，对外可见的
  状态能在合理时间内恢复（要么数据从磁盘 / 上游回流，要么内存重建后下游会
  自然重新填充）。

## 服务状态对照表

| 服务名 | 提供方插件 | 内存态内容 | 持久化来源 | bounce 是否保留 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `app` | `@aalis/core` | App 实例 | n/a | n/a | 由 host 注入，永不 bounce |
| `plugins` | `@aalis/core` | PluginManager | n/a | n/a | 由 host 注入，永不 bounce |
| `commands` | `@aalis/plugin-commands` | 命令注册表（Map） | n/a | 否 | bounce 后由各插件 apply 时重新 `register` |
| `agent` | `@aalis/plugin-agent-default` | preprocessor / processor 列表 | n/a | 否 | 同上，依赖下游插件 apply 时回注 |
| `tools` | `@aalis/plugin-agent-tools` | tool 定义 Map | n/a | 否 | 同上 |
| `webui-server` | `@aalis/plugin-webui-server` | 已注册页面 Map | n/a | 否 | bounce 后下游插件通过 `useWebuiService.registerPage` 重新注册 |
| `doctor` | `@aalis/plugin-doctor` | `lastReport` 单例 | n/a | 否 | 重载后报告丢失，需重新 `runChecks` |
| `scheduler` | `@aalis/plugin-scheduler` | 任务调度状态 | `data/scheduler-jobs.json` | 是（持久部分） | bounce 后从 JSON 读回；运行中的 timer 会重建 |
| `authority` | `@aalis/plugin-authority` | 角色规则 | 配置文件 | 是 | 规则随配置一起回填 |
| `session-manager` | `@aalis/plugin-session-manager` | 活跃 session Map | 视下游 memory 插件 | 部分 | 历史走 memory 服务，活跃句柄丢失需重建 |
| `memory` | `@aalis/plugin-memory-sqlite` / `-mongodb` / `-summary` / `-inmemory` | LRU / 缓存 | SQLite / MongoDB（内存版除外） | 是（持久驱动）/ 否（inmemory） | inmemory 驱动 bounce 即清空 |
| `vectorstore` | `@aalis/plugin-vectorstore-lancedb` / `-flat` | 索引句柄 | `data/lancedb/` / 平铺文件 | 是 | 句柄重建后数据可用 |
| `embedding` | `@aalis/plugin-embedding-*` | HTTP client | n/a | n/a（无状态） | 重建即可用 |
| `llm-*` | 各 LLM provider 插件 | HTTP client | n/a | n/a | 同上 |
| `storage` | `@aalis/plugin-storage-local` | fs handles | 磁盘 | 是 | 文件系统抽象，bounce 安全 |
| `tools.search` | `@aalis/plugin-tool-search` | 配置 | n/a | n/a | 重建即可用 |
| `tools.code-runner` | `@aalis/plugin-tool-code-runner` | runner 进程池 | n/a | 否 | 重建会创建新进程池，正在执行的任务会丢失 |
| `tools.browser` | `@aalis/plugin-tool-browser` | Playwright 会话 | n/a | 否 | 重建会断开当前浏览器会话 |
| `todo-list` | `@aalis/plugin-todo-list` | 任务列表 | 视配置（默认内存） | 否（默认） | 默认内存态，bounce 即丢 |
| `user-profile` | `@aalis/plugin-user-profile` | profile 缓存 | memory 服务 | 是 | 走 memory 服务持久化 |

## 重载注意事项

1. **下游依赖会短暂 bounce**：`App.reloadPlugin(target)` 时，target dispose
   导致其 provided 服务从 ServiceContainer 中移除，所有依赖该服务且声明在
   `inject.required` 中的下游插件会被 `recompute(service-down)` 自动 dispose+pending。
   随后 target 重新 apply 注册新服务，下游被重新激活。期间存在 100ms 量级
   的不可用窗口。
   `optional` 依赖同样会被 bounce，以重新 apply 拿到新服务实例。

2. **避免 bounce 持有外部连接的插件**：上表中标注 "重建即可用" 的插件可以
   安全 bounce；标注 "进程池 / 浏览器会话" 的服务 bounce 会断开外部资源，
   建议先停止依赖工作流再重载。

3. **配置变更走 `updatePluginConfig` 而非 `reloadPlugin`**：前者会把新配置
   写回 `ctx.config` 后 bounce；后者只重新 import 代码，不更新配置。

4. **多实例插件 (`name:suffix`) 仅作用于指定 instanceId**：同 module 的其
   他实例不受影响，需各自调用 `reloadPlugin(instanceId)`。

5. **integration / e2e 推荐在 bounce 后等 `plugins:changed`**：直接调用 bounce
   之后立即 assert 服务可用会读到 dispose 中间态，应等 recompute 收收尾发出
   `plugins:changed` 事件后再断言。

## 增量重载的 API 速查

```ts
// 重新 import 单个插件的代码并 bounce
await app.reloadPlugin('@aalis/plugin-foo');

// 不重新 import，仅 dispose+重新 apply（罕用，调试时可手动调）
await ctx.getService('plugins').bouncePlugin('@aalis/plugin-foo');

// 配置变化（含 enable/disable）后的标准入口
await ctx.getService('plugins').updatePluginConfig(name, newConfig);

// 全局收敛：所有生命周期路径的统一入口，按 reason 调度拓扑 dispose / activate
await ctx.getService('plugins').recompute({ type: 'plugin-state-changed' });
// （softReload() 是它的薄壳，仍可用）
await ctx.getService('plugins').softReload();
```
