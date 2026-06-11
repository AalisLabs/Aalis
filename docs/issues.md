- 问题

0. 如果从头实现一遍各个插件，并在这个过程中检查潜在的问题，重新实现干净的代码，能否解决当前各类问题与可能存在的潜在问题？是否现实？
3. 扩展工具/指令的权限，参数不同可以需求不同的权限等级而不是根据当前工具/指令不变，这样可以类似存储工具的data的读是1级，但写是3级。但是否要考虑plugin等的权限如何管理？是否可能被恶意攻击者通过某种方式绕过？
   - ⏸️ 待重新设计（首版"参数级动态提权"已回退 commit 54d4b18）。首版思路是在 tool 层用 `resolvePermissions(args)` 解析参数→产出路径级权限→authority 按路径映射更高等级。问题：①这是**以 surface（tools/commands）为中心**的补丁，而敏感操作有多个 surface（command/tool/**WebUI action**/scheduler/onebot），surface 中心天生漏；②对 `code_runner` 这种图灵完备参数根本无法靠解析 args 判断会写哪个文件（首版残留风险即源于此）。
   - 🔴 审查中发现的结构性洞：`/api/page-action/:plugin/:method`（webui-server/src/routes/plugins.ts）直接调用插件 `actions[method]`，**零权限校验、无调用者身份**。导致同一操作"设置用户权限"在 command 路径有守卫(`authority:2`+防越权自查)，在 WebUI action 路径(`setUser`)却可直接设 owner。当前唯一防线是 webui 未登录默认可信（与新功能 #1 登录界面挂钩）。
   - 🎯 重新设计方向：**以插件内的抽象能力(capability)为中心**——敏感操作在操作边界统一 `authority.require(identity, capability)` 检查，任何 surface 进来都过同一闸；`ExecutionGuard` 退化为 tool/command surface 的适配器。前置依赖：身份贯通（每个 surface 携带调用者 platform/userId；WebUI action 当前缺失），与登录/scoped 沙盒(#1)合并设计。
   - ✅ 2026-06-12 第二版三件套已落地（先把所有 surface 收到同一闸，参数级提权重新上线）：
     1. **参数级动态提权**（单调：只升不降）：file 工具产出 `storage:path:<uri>:<op>` 路径级权限标识，authority 新增 `requiredAuthorityFor(permissions)`，守卫取 `max(声明等级, 清单命中等级)`。内置保护：写/删 `data:/users.json`、`data:/scheduler-jobs.json`（防自我提权/注入 owner actor）与 `aalis:/` 源码根（写源码=重启后任意代码执行）均需 owner 级；`permissionAuthority` 配置（glob→等级）可覆盖/扩展。
     2. **WebUI page-action 闸门 + 身份贯通**：路由层构造 `ActionCaller`（暂固定 webui:console=owner，登录上线后换会话真实账户），按 `actionsMeta` 声明等级过 authority 闸，**未声明默认要求 owner（默认拒绝）**；caller 经 handler 第三参下传，`setUser` 补上与 `/grant` 同语义的防越权（不能设他人 >= 自身等级）。
     3. **拆除 `bypassGuard`**：commands 入站中间件改用 `message.actor`（scheduler 创建时固化的创建者身份）过真实守卫，与 agent→tools 路径同语义；`skipSafetyCheck`（cron 无人确认弹窗）保留。代码中两处 DANGER 临时方案注释随之清除。
   - ⏭️ 剩余（与登录/沙盒 #新1 合并推进）：WebUI 其余 REST 路由（`PUT /api/config` 等）仍默认可信；`code_runner` 图灵完备参数需进程级隔离（容器化 #新6）；登录后为各 action 标注低于 owner 的 `actionsMeta` 等级。

8. core 全文评审（2026-06-12，人工通读 + 18 代理对抗验证）发现的待修缺陷，按危害排序：
   1. 🔴 `EventBus.emit`（events.ts）串行 await 且无 per-handler 隔离：一个 handler 抛错跳过同事件全部后续 handler 并使 emit reject（已复现）。最坏衍生：`plugin-activation.ts` 的 `plugin:loaded` emit 在激活 try 块**内**——任意旁观插件监听器抛错会把刚激活成功的无辜插件打成 error 终态，归因错位。修法：emit 逐 handler try/catch 聚合 + 该 emit 移出 try。
   2. 🔴 sticky 事件补发（events.ts `queueMicrotask` 内 `void handler(...)`）无 try/catch：热重载 bounce 后补发 'ready'/'app:started'，handler 同步抛错直达 uncaughtException 崩进程（已复现；同份代码首轮启动抛错只是激活失败，bounce 后却致命）。
   3. 🟡 `whenService` 多 provider 挂死：任一同名 entry 注销（含败者）→ 无条件 cleanup 且胜者不重发 registered → 订阅永久脱挂；preferService 切偏好也不触发重挂。今天唯一现役用户是单 provider 故潜伏，但 per-model LLM 多 entry 是框架明文设计，按文档用即触发。修法：unregistered 分支 cleanup 后重新 get(name)，仍有胜者则 reattach。
   4. 🟡 `HookRegistry.run` 持活数组：handler 执行中 dispose（splice）跳过下一个 handler 且误报 reachedEnd=true（已复现）；`unregisterByContext` 换数组后旧 dispose 闭包变 no-op（中间件泄漏）。修法：run 开头快照 + dispose 改查 registry 当前数组。
   5. 🟡 `ScopedConfigManager`：未覆写的 setPluginEnabled/setServicePreference 等写**穿透到父配置**（快照按引用共享）；save() 抛错/watch() no-op 双向违反基类契约；继承的 syncPluginDefaults 在 scope 实例上有变更即炸。沙盒功能（新 #1）启用 createScope 前必须先修。修法：组合替代继承，显式逐方法委托。
   6. 🟢 杂项：Context.dispose 的 unregisterByPlugin 只通知胜者 entry（应遍历 getEntries）；recompute 重入保护是丢弃而非排队（lost wakeup）；unload() 不设 reloading 守卫（与 disablePlugin 不对齐）；getStatus 内联类型与 PluginStatusEntry 重复无编译期链接；AalisEvents 索引签名使事件名 typo 不设防（对照 HookContextMap 封闭）；'ready'/'app:started' 语义重叠；clearSticky 不清 'app:started'。
   - ✅ 已修（d222483）：包根漏导出 `ServiceTypeMap`/`ServiceOf` → 15+ api 包 declaration merging 静默失效，`getService` 字面量强类型从未生效（tsc 双向实证）。

- 新功能计划
1. 考虑开始兴建 scoped/app 沙盒，为不同scope的webUI提供不同的权限等级与可见性/乃至引入登录界面，可以作为类似chatGPT/claude分发
2. 商店还没正式开始制作
3. 允许进行文档内图片识别
4. onebot 信息撤回 / 知道对方信息是否被撤回了？
5. 按会话/时间/前多少到多少条取最近信息（当前应该有会话没时间限制）
6. 为了解决权限问题，为指令执行引入容器化（？）

- 考虑对插件重新进行统一安全与漏洞检查，当前各种位置潜在bug很多，考虑制作插件市场并在这个过程中重新审阅每个插件潜在的问题，甚至在这个过程中着手从头重写逻辑
  - 📌 2026-06-12 决议：**先落地 #3 capability 权限重设计（插件契约定型），再启动插件市场**；上架流程作为逐插件安全审查的强制关卡。仓库形态：保持 monorepo，**暂不发布 npm**，市场先只索引 monorepo 内插件（本地安装，package-manager 已支持），npm 发布等契约稳定后再议。整体重写（#0）不做：问题集中在权限横切面，借上架审查逐个修缮性价比更高。

- 如果你拿不准，有建议，或者是有其他问题，请你使用你的问题工具向我询问，我们一起协商敲定解决与修改方案。但你不要擅自停止推理，你有问题就使用问题工具，不要停止推理或改动，形成类似交互式的处理。完成修改后尝试测试，CI/CD，提交与推送