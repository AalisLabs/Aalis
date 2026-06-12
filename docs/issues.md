# Issues & Roadmap

> 分区约定：**待办问题**（需要修/设计的缺陷与风险）→ **新功能计划**（roadmap）→
> **已决议事项**（方向性结论，避免反复讨论）→ **已完成归档**（含修复摘要，供回溯）。
> 编号沿用历史（#3、#8 等），新条目顺延编号。

## 待办问题

### #3 权限体系：capability 中心重设计（进行中）

> 原始问题：工具/指令的权限应随**参数**而非仅随声明变化（如存储 data 读=1 级、写=3 级）；
> 同时要回答 plugin 权限如何管理、能否被恶意绕过。

- ⏸️ 首版「参数级动态提权」已回退（commit 54d4b18）：以 surface（tools/commands）为中心天生漏
  （敏感操作有 command/tool/WebUI action/scheduler/onebot 多个 surface）；且 `code_runner`
  这类图灵完备参数无法靠解析 args 判断实际写哪个文件。
- 🎯 终局方向：**以插件内的抽象能力(capability)为中心**——敏感操作在操作边界统一
  `authority.require(identity, capability)`，任何 surface 进来都过同一闸；`ExecutionGuard`
  退化为 tool/command surface 的适配器。前置依赖：身份贯通（每个 surface 携带调用者
  platform/userId），与登录/scoped 沙盒（新功能 #1）合并设计。
- ✅ 2026-06-12 第二版三件套已落地（所有 surface 收同一闸，参数级提权重新上线）：
  1. **参数级动态提权**（单调只升不降）：file 工具产出 `storage:path:<uri>:<op>` 路径级权限标识，
     authority 新增 `requiredAuthorityFor(permissions)`，守卫取 `max(声明等级, 清单命中等级)`。
     内置保护：写/删 `data:/users.json`、`data:/scheduler-jobs.json`（防自我提权/注入 owner actor）
     与 `aalis:/` 源码根（写源码=重启后任意代码执行）均需 owner 级；`permissionAuthority`
     配置（glob→等级）可覆盖/扩展。
  2. **WebUI page-action 闸门 + 身份贯通**：路由层构造 `ActionCaller`（暂固定 webui:console=owner，
     登录上线后换会话真实账户），按 `actionsMeta` 声明等级过 authority 闸，**未声明默认要求
     owner（默认拒绝）**；caller 经 handler 第三参下传，`setUser` 补防越权（不能设他人 >= 自身等级）。
  3. **拆除 `bypassGuard`**：commands 入站中间件改用 `message.actor`（scheduler 创建时固化的
     创建者身份）过真实守卫，与 agent→tools 路径同语义；`skipSafetyCheck`（cron 无人确认弹窗）保留。
- ⏭️ 剩余工作（与登录/沙盒〔新功能 #1〕合并推进）：
  - WebUI 其余 REST 路由（`PUT /api/config` 等）仍默认可信；
  - `code_runner` 图灵完备参数需进程级隔离（容器化，新功能 #6）；
  - 登录后为各 action 标注低于 owner 的 `actionsMeta` 等级；
  - 📌 2026-06-12 决议同车项（core 词汇审计 #3 项）：`actions`/`actionsMeta` 经
    declaration merging 迁出 core 落 webui-api（先例：subsystem/extends）；
    **`ActionCaller` 与 authority-api 已有的 `UserIdentity` 同构，合并为一个
    身份类型落 authority-api**；core 的 getStatus 删 `actionNames`（消费方自取
    `Object.keys(module.actions)`）。capability 闸落地时一并做，避免双倍改动。

### #9 core 设计层面的已知妥协（低优先级，记录在案）

- `'ready'` 与 `'app:started'` 语义重叠（均为 sticky 启动里程碑，仅触发时点略异：
  ready=服务就绪后、started=watch 建立后）。合并属破坏性变更，暂保留双事件并以
  文档区分；新代码优先用 `'app:started'`。
- `ScopedConfigManager` 采用「extends + 全量显式覆写 + 反射防漂移单测」而非纯组合
  （纯组合需抽接口，波及 `Context.config` 全链类型）。基类新增公开方法时**必须**
  同步覆写，否则 test/core/config.test.ts 的防漂移用例会拦下。
- `PluginModule.actions/actionsMeta/ActionCaller` 是 host-RPC 形状的槽位，
  纯化决议见 #3 同车项（暂留 core）。
- ~~scope 的 syncPluginDefaults 不继承父配置 trimUnknownFields 政策~~
  （已修：政策字段公开只读，scope 构造时按值继承；热重载路径同步对齐——
  handleConfigFileChanged 先过 syncPluginDefaults 再 diff/bounce）。

## 新功能计划

1. scoped/app 沙盒：为不同 scope 的 WebUI 提供不同权限等级与可见性，乃至引入登录界面，
   可作为类似 ChatGPT/Claude 的分发形态。（与 #3 剩余工作合并设计；core 侧 createScope
   的配置写穿透缺陷已修，见归档 #8.5）
2. 插件市场 / 商店（启动条件见「已决议事项」）
3. 文档内图片识别
4. onebot 消息撤回 / 感知对方消息是否被撤回
5. 按会话/时间/区间取最近消息（当前只有会话维度，没有时间限制）
6. 指令执行容器化——为 `code_runner` 等图灵完备入口提供进程级隔离（#3 的依赖项）

## 已决议事项

- 📌 2026-06-12 市场/重写/仓库形态：**先落地 #3 capability 权限重设计（插件契约定型），
  再启动插件市场**；上架流程作为逐插件安全审查的强制关卡。仓库保持 monorepo，
  **暂不发布 npm**，市场先只索引 monorepo 内插件（本地安装，package-manager 已支持），
  npm 发布等契约稳定后再议。
- 📌 整体重写（原 #0「从头实现一遍各插件」）**不做**：问题集中在权限横切面，
  借市场上架审查逐插件修缮性价比更高。
- 📌 core 设计理念（评审/修复时的不变约束）：**环境无关**（不读 process.env / 不碰 I/O，
  一切经 provider 注入）、**抽象化**（IoC + 事件 + 钩子 + 能力声明，不感知业务）、
  **最简化**（不引第三方运行时依赖，API 面最小）、**忒修斯之船**（任何插件可被热替换，
  core 自身各子系统也可经 AppOptions 注入替换）。
- 📌 2026-06-12 AalisEvents **保持类型封闭**（对扩展开放、对拼写错误封闭）：契约可枚举、
  依赖边在包图中可见；动态事件名的官方出路是插件在自己命名空间合并模板字面量签名
  （`` [k: `myns:${string}`]: [payload: T] ``，TS 4.4+）——该模式已写入
  docs/core/events.md 与 docs/plugin-author-guide.md §10。
- 📌 2026-06-12 core **不拆 kernel 包**：包是发布/版本化单位而非模块化单位；拆包在
  当前（无 kernel 独立消费者）收益为零，且 declaration merging 锚定在 `'@aalis/core'`
  包名上，拆包=迁移全部插件的 merging 目标。重新评估触发条件：①core 发 npm 且要给
  基底层单独 1.0 承诺；②出现 kernel-only 真实消费者；③多人协作需要 Conway 边界。
  内部「基底层（events/hooks/service/context）不得 import 编排层（plugin/app）」的
  架构测试已补：test/core/architecture.test.ts（含「新文件必须分层登记」完备性断言）。

## 已完成归档

### ✅ #8 core 全文评审缺陷（2026-06-12 发现，254c2c0 全量修复）

> 来源：人工通读 + 18 代理对抗验证；修复全程未引入新依赖、未破坏既有 94/584 测试。

1. 🔴 `EventBus.emit` 串行 await 无 per-handler 隔离 → **已修**：逐 handler try/catch，
   错误经新增 `onHandlerError` 回调上报（App 注入 logger，外部 bus 以 `??=` 尊重已有上报器），
   emit 永不 reject；`plugin:loaded` emit 移出激活 try 块，旁观监听器抛错不再把无辜插件打成 error。
2. 🔴 sticky 补发无 try/catch（bounce 后同步抛错崩进程）→ **已修**：补发路径捕获同步
   异常与异步 rejection，统一走 `onHandlerError`。
3. 🟡 `whenService` 多 provider 挂死 → **已修**：重写为「对齐当前胜者」语义
   （不变量 attached === getService(name)）：败者上下线不打扰、胜者注销重挂次优、
   新增 `service:preference-changed` 事件使 preferService 切偏好同样触发重挂。
4. 🟡 `HookRegistry.run` 持活数组 → **已修**：run 快照遍历 + 执行前查活（运行中被
   dispose 的 handler 跳过）；dispose 闭包改查 registry 当前数组，`unregisterByContext`
   换数组后不再 no-op 泄漏。
5. 🟡 `ScopedConfigManager` 写穿透/契约违反 → **已修**：显式覆写基类全部公开方法
   （写只进 overlay，copy-on-write）+ 反射防漂移单测；save() 改为与基类"无 provider
   内存模式"同语义的 **no-op**（偏离原修法的"抛错"：通用插件代码在 scope 内调 save()
   不应被炸，隔离性由写路径保证）；syncPluginDefaults 经虚分派合并进 overlay。
6. 🟢 杂项 → **已修**：unregisterByPlugin 遍历全部 entry（按实例去重）；recompute
   重入改排队（合并请求、shutdown 优先；不返还在飞 promise 防 apply 内自我死锁）；
   unload/bouncePlugin 补 dispose 段守卫（新 `suspended` 标志与单飞 `reloading` 分离）
   且 unload 收尾级联 softReload；getStatus 复用 `PluginStatusEntry`（编译期链接）；
   `clearSticky()` 清空全部 sticky（含 app:started）。
   **AalisEvents 索引签名已移除**（事件名 typo 编译期设防，对齐 HookContextMap）：
   全仓野生事件补契约——token:usage/token:request → plugin-agent-api、
   memory:messages-deleted/history:changed/session:compress(ing) → plugin-memory-api、
   scheduler:job:* → plugin-scheduler、terminal:claimed/released → plugin-cli 同形声明；
   顺手抓获真 bug：plugin-tool-onebot `ctx.on('dispose', ...)` 监听不存在的事件
   （access checker 泄漏）→ 改 `ctx.onDispose`。
   未修而记录在案的两项（语义权衡）移入待办 #9。

### ✅ core 词汇泄漏审计五项（2026-06-12 审计并落地，3a4317b / 4f2af20 / Logger / 政策共 4 commit）

> 审计判据：内核组件合格标准是"是否是让其他一切可被替换的不动点"；
> 五项均为词汇/政策泄漏而非机制泄漏，修后 core 更小更纯。

1. **ConfigSchema 词汇归位**（4f2af20）：`SchemaFieldType` 改为 SchemaFieldTypes
   注册表（merging 扩展点），`'llm-ref'` 落 llm-api、`secret/dynamicOptions/allowCustom`
   落 webui-api 注入，全仓零使用的死字段 `dynamicProviders` 连同前端取数管线删除。
2. **Logger 接口化**：core 持有 `interface Logger`（四方法+child）+ `DefaultLogger`
   缺省实现，`AppOptions.logger` 注入点（pino 等适配自此可行）；删除零使用死 API
   `setLevel`。不能拆成插件——自举悖论：激活第一个插件之前 core 就需要日志。
3. **actions/actionsMeta/ActionCaller**：决议与 #3 capability 重设计同车（见待办 #3）。
4. **两处政策开放注入**：`configSync.trimUnknownFields`（schema 外字段裁剪/保留）、
   `serviceRecovery.autoEnableDisabled`（必需服务恢复是否压过用户禁用），默认值
   均保持现行为。
5. **SafetyLevel/PermissionId 迁至 authority-api**（3a4317b）：权限词汇归位，
   消除 PermissionId 双源定义。

### ✅ 包根漏导出 ServiceTypeMap/ServiceOf（d222483）

15+ api 包 declaration merging 静默失效、`getService` 字面量强类型从未生效（tsc 双向实证）。

---

- 如果你拿不准，有建议，或者是有其他问题，请你使用你的问题工具向我询问，我们一起协商敲定解决与修改方案。但你不要擅自停止推理，你有问题就使用问题工具，不要停止推理或改动，形成类似交互式的处理。完成修改后尝试测试，CI/CD，提交与推送
