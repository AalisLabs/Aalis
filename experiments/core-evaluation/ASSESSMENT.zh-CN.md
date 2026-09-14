# Aalis Core 相对 Cordis 的实测评估与演进建议

2026-09-15。目标按“可嵌入不同 JavaScript 宿主、能组合不同业务插件的通用内核”评估。本文区分已测行为、现有契约的缺口，以及新目标要求的能力；不以 API 数量或单一分数定义“现代”。

**判断：Aalis 已具有可用的通用内核基础，值得继续发展；暂时没有证据说明整体比 Cordis 更通用。** 环境可移植性已由真实执行证明，默认服务选择与贡献点是可以保留的特点。最迫切的工作是补齐组合时的生命周期保证；最大的表达力差距是作用域与资源归属。无需先重写整个内核，也不应把 Agent 循环、会话日志等业务组件搬进 Core 来增加功能数量。

比较对象是 DSH 实际维护的 Cordis 源码，固定提交 `c291e7961a515f6d7af9304e7fd1d257929aef26`。DSH 的 `packages/core` 是会话、工具和 Agent 协议层，未计入 Cordis 内核的能力评分。[DSH vendoring 说明](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/vendor/README.md)、[产品层说明](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/core/README.md)。

**现有基础与距离。**

| 目标 | 本次证据 | 评估 |
| --- | --- | --- |
| 脱离 Node 专属环境运行 | Aalis 在真实 Chrome 主线程及 Dedicated Worker 各通过 8 项检查；`process`、`require`、`Buffer` 均不存在。Cordis 在相同宿主各通过 4 项基础检查 | 已有基础；可移植性并非 Aalis 独有。检查集合不同，不能比较通过数量 |
| 外部项目可以消费类型和产物 | 新编译 Core 的 Node ESM 裸包导入通过；Bundler、Worker、NodeNext 消费通过，`types: []`、`skipLibCheck: false`；接口增广的正负检查生效 | 正常入口可用；不是只在 monorepo 源码别名下成立 |
| 多实现之间选择默认提供者 | Aalis 的偏好、优先级、注册顺序、回退与备用项变化均符合观察预期 | 有直接的默认机制。Cordis 同作用域拒绝重复提供者，通过作用域并存，两者语义不同 |
| 局部组合而不影响其他子树 | Cordis `isolate` 支持分支独立实现和显式共享标签；Aalis `fork` 下的三个上下文都看到同一胜者 | 对新通用组合目标是明显差距；Aalis 现有共享语义不是实现错误 |
| 共享服务所创建资源归调用方 | Cordis 的可追踪 Service 在同步和跨 await 调用中都跟随调用方 Fiber；Aalis 裸服务实例不会自动重绑定 | Aalis 显式传 owner 的正向对照同样成功。应统一可选择的归属协议，不必照搬 Proxy |
| 异步卸载有可信完成边界 | 双方注册过的异步资源都能被等待；Aalis 初始化中卸载的正向探针通过；另有下述重入和组合缺口 | 优先把现有承诺兑现，再扩展生命周期 API |
| 扩展项可以确定性组合 | Aalis 既有贡献点测试通过，支持按全局键排序、替换和清理 | 是值得保留的 API 约束；不能扩张为全应用执行确定或可回放 |
| 稳定的库边界 | 根入口可消费，但无 `exports`，内部 `dist/context.js` 可被外部深导入；当前为 0.12.1 | 接入可行，冻结公开面及迁移政策尚需继续做 |

类型消费通过不等于端到端类型安全：额外的严格 TypeScript 反例声明 `increment(): number`，却通过 `provide` 注册返回 string 的实现，编译仍成功，运行时也确实得到 string。原因是当前生产者入口接受 `unknown`。这是一项已验证的类型边界缺口，应优先于更复杂的类型系统重设计；本次未对 Cordis 做相同的外部类型反例，不能据此给双方类型安全排名。

`fork` 共享注册表、独立 App 分开注册表，是当前有意的设计。此前[插件作者指南](../../docs/plugin-author-guide.md)选择“一进程一个产品实例”的使用模型。新目标若包含编辑器多面板、同应用多个独立运行单元，应重新评估该取舍；这不是要求引入企业多租户或安全沙箱。

**测试规模与结果的含义。**

- 既有 Core 测试：22 个文件、206 个测试全部通过。
- Core 单独覆盖率：行/语句 88.27%，分支 86.39%，函数 92.35%。它衡量执行覆盖，不证明所有状态组合都正确。
- 新增对抗及比较：27 个 Vitest 探针，用确定性的 Promise 门闩等构造顺序。测试变绿表示观察被复现；JSON 中明确记录未满足的目标。
- 可移植性另外运行真实浏览器、Worker、编译器和外部包消费者，不计入 27 个 Vitest 探针。

原始材料：[基线和源码哈希](results/baseline.json)、[生命周期记录](results/aalis-lifecycle-contracts.json)、[组合记录](results/composition-contracts.json)、[双方对照记录](results/cordis-comparison.json)、[可移植性记录](results/portability.json)。复现命令见 [README](README.md)。

**两处已经复现的缺陷。**

1. `whenService` 回调中改变胜者，会遗失清理函数。A 的首次挂载回调切换至 B，B 回调返回 cleanup 后，外层 A 的 cleanup 覆盖它。观察轨迹为 `attach:a → attach:b → cleanup:a`，退订后 B 的模拟订阅仍存活。违反“被替换或退订的挂载能正确清理”的公开生命周期承诺。见 [测试](aalis-lifecycle.test.ts) 的 `whenservice-reentrant-provider-switch`，实现位置 [Context.whenService](../../packages/core/src/context.ts)。
2. 重算竞争会吞掉 optional 依赖下线的特殊语义。消费者明确声明 `requiresBounceOnDepChange`：正常情况下下线会使其重挂；在其他插件初始化期间发生同一事件，重算合并后消费者没有重挂，继续保留已注销的 provider。该限制原先已在源码注释承认，本次用控制组和竞争组复现。见 `queued-optional-service-down`，实现位置 [PluginManager.recompute](../../packages/core/src/plugin.ts)。

第一处曾在临时 Core 副本中加入一个窄检查验证根因，同一探针可以清理 A 和 B；生产源码没有改动。该检查不覆盖 A→B→A 或 cleanup 本身重入，不能直接视为完整修复。正式修复宜使用挂载代次/所有权校验或串行收敛机制，并为这些变体补回归测试。

**另有三项组合保证需要明确。**

| 探针 | 实际结果 | 应如何理解 |
| --- | --- | --- |
| `composition/C1`：多提供者与额外依赖图组合后关停 | 运行时选中 primary；关停先关闭 primary，consumer 清理时惰性查询拿到 fallback | 不能保证当前胜者晚于消费者关闭。根因是拓扑按首个声明提供者建图，与实际选择不一致。不是所有多提供者部署都会出错，也没有在本测试中证明数据丢失 |
| `composition/C2`：`await useModule` 返回的 disposer | `await off()` 返回时，异步清理尚未完成 | 当前 off 明确是同步函数，属于能力缺口而不是违约；动态模块缺少统一的可等待卸载句柄 |
| `composition/C3`：两个 `fork` 使用同一字符串 id | 销毁左侧会移除仍未 disposed 的右侧服务 | 当前允许重名 id，而归属清理使用该 id；需要区分显示名和资源所有权。`useModule` 已做名称唯一化，不应笼统说所有动态模块都有这个问题 |

多提供者的修法不能简单地把所有 provider 都连入依赖图：这可能制造原本没有的环。需要区分“有一个实现即可激活”的依赖与“已使用的具体实例必须存活到清理完成”的资源依赖，再定义关停和运行中切换分别保证什么。

**Cordis 也有需要正确使用的边界。** 对照 `C9-independent` 把服务注册与资源关闭放在两个独立顶层 effects 中，观察到 `provider:close → consumer:saw-closed`；使用一个组合 effect 明确逆序释放后，`C9-grouped` 得到 `consumer:saw-open → provider:close`。因此不能从依赖自动联动推出任意资源都自动按安全顺序关闭。[实际 Fiber 清理实现](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/vendor/cordis/src/fiber.ts)。

**建议按以下顺序推进。**

| 批次 | 应做的事 | 验收条件 | 改动规模与风险 |
| --- | --- | --- | --- |
| 1：兑现已有契约 | 修 whenService 重入；保留排队中的相关服务下线信息；明确并修正多提供者关停契约 | A→B→A、cleanup 内切换、退订与切换交错均恰好清理一次；竞争组与控制组等价；约定依赖关系下资源不会提前关闭 | 前两项集中在 Core 内部，较小；关停涉及绑定语义，需单独设计 |
| 2：补齐生命周期接口 | 为动态挂载增加可等待的模块句柄；统一同步请求关闭与异步等待完成；区分显示 id 与资源归属 | `await` 卸载后受管资源全部完成或明确报告超时；重名标签不互相清理；旧 API 保持原语义 | 中等；所有权还涉及 `unregisterByPlugin(contextId)`、entryId 和贡献排序，不能只换一个 Map key |
| 3：先做作用域 RFC 与两个小原型 | 用“编辑器两个独立面板”和“一个应用两个独立任务运行单元”验证局部服务/事件/贡献是否必要；若成立再提供 opt-in Scope | 局部覆盖不污染父或兄弟；继承和遮蔽可预测；偏好限制在正确范围；子作用域销毁不误清其他区域 | 最大的一项表达力工作；不要悄悄改变现有 fork 的共享语义 |
| 4：标准互操作与发布工程 | 增补合作式取消、标准资源释放适配、提供者类型检查；跨宿主 CI；审计深导入后引入 exports；分层稳定 API | 取消请求与清理完成可区分；错误服务实现编译失败；新产物在真实宿主消费；内部深路径有明确政策 | 可拆分推进；其中 CI 和已知服务名的类型约束可提前 |

以上批次是依赖顺序与相对成本判断，没有测量开发工时，不能承诺具体周数。第一批应先做，而“完整 Scope”不应成为所有改进的前置条件。

**“现代”可以落实成这些契约，而不是增加一批专用名词。**

- 合作式取消：卸载开始时向受管操作发出取消信号，随后等待清理；取消请求不等于操作已终止，超时也不等于资源已释放。可以采用平台的 [AbortSignal 协议](https://dom.spec.whatwg.org/#interface-abortsignal)，无需把 Agent 任务状态放进 Core。
- 资源互操作：在现有清理链上适配 `Symbol.dispose` / `Symbol.asyncDispose` 或相应资源对象，不再维护第二套平行的清理顺序。接口语义可参考 [TC39 显式资源管理设计](https://github.com/tc39/proposal-explicit-resource-management)，实际支持范围仍需通过目标宿主和编译器测试决定。
- 类型安全：消费者推断正确还不够；生产者 `provide` 也应约束已知服务名对应的实现类型。优先加强现有字符串 API；带类型的服务 token 可以作为可选扩展，但不必立刻迁移全部插件。
- 可观察性：Core 需要可订阅的生命周期状态、依赖绑定和资源数量等稳定观察面；UI、持久化日志、指标导出放在外部。已有 label 与诊断接口可复用，不必从零另造系统。

**值得保留的边界。** events 负责通知，hooks 负责流程干预，services 负责解析实现，contributions 负责汇集数据。通用 Scope 与生命周期可以承载这些原语；会话、模型、任务队列、运行日志、权限策略、分布式调度仍适合由独立能力包实现。这样既能提高表达力，也保留现在容易嵌入的内核形态。

本次没有做吞吐、内存长期增长、跨进程崩溃恢复、Deno/Bun/Cloudflare 宿主、第三方插件兼容性或用户接入时间的横向测试。浏览器 smoke 覆盖的是本文列出的操作，不代表所有 API 已覆盖；独立 App 和逻辑作用域也不是敌对插件的安全隔离。当前不能给“领先百分比”或整体可靠性排名。

下一阶段最有价值的交付是：把第一批发现转成正式回归，把跨宿主消费者放进 CI，再用两个小型宿主原型决定 Scope 的最小语义。届时才能用结果说明 Aalis 在哪些通用场景减少了应用层补丁，以及哪些新增复杂度确实值得承担。
