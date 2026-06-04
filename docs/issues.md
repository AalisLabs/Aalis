- 问题

0. 如果从头实现一遍各个插件，并在这个过程中检查潜在的问题，重新实现干净的代码，能否解决当前各类问题与可能存在的潜在问题？是否现实？
1. ~~webui有问题：当agent正在进行推理时选择强制停止推理后，如果刷新页面，还是显示可以停止，并且不管怎么按，都是这样，虽然推理实际上已经停止了。应该主要是显示bug？~~ ✅ 已修复：根因是「回合终态」收口不对称——只有正常路径(`outbound:message`)会清 `generating`，中止路径只发 `outbound:stream{done}` 却没翻 `generating`，残留 buffer 致刷新后回 `stream_resume{done:false}`。修法：webui-server 的 `outbound:stream` done 分支补 `generating=false`+清理，与正常路径对称。
2. ~~webUI处，agent完成的消息气泡上方的token计算似乎偏大，怎么可能一分钟的推理用几十万token呢~~ ✅ 已修复：气泡角标原本显示 `turnUsageAcc.totalTokens`，它在工具迭代循环里把每轮**重发的整段上下文**(promptTokens)累加，N 次迭代就把同一份上下文重复计入 N 次 → 虚高几十万。修法按"右上角=当前上下文占用、气泡=本次回复生成量"的语义：①agent 中 `promptTokens` 改为取最后一次调用的上下文大小(覆盖而非累加)，`completionTokens` 保持累加(真正新生成的输出)，`totalTokens=两者和`；②气泡角标主显改为 `completionTokens`(本次生成量)，hover 标注"本次生成/上下文"。右上角徽章本就显示当前上下文占用，无需改。
3. 扩展工具/指令的权限，参数不同可以需求不同的权限等级而不是根据当前工具/指令不变，这样可以类似存储工具的data的读是1级，但写是3级。但是否要考虑plugin等的权限如何管理？是否可能被恶意攻击者通过某种方式绕过？
   - ⏸️ 待重新设计（首版"参数级动态提权"已回退 commit 54d4b18）。首版思路是在 tool 层用 `resolvePermissions(args)` 解析参数→产出路径级权限→authority 按路径映射更高等级。问题：①这是**以 surface（tools/commands）为中心**的补丁，而敏感操作有多个 surface（command/tool/**WebUI action**/scheduler/onebot），surface 中心天生漏；②对 `code_runner` 这种图灵完备参数根本无法靠解析 args 判断会写哪个文件（首版残留风险即源于此）。
   - 🔴 审查中发现的结构性洞：`/api/page-action/:plugin/:method`（webui-server/src/routes/plugins.ts）直接调用插件 `actions[method]`，**零权限校验、无调用者身份**。导致同一操作"设置用户权限"在 command 路径有守卫(`authority:2`+防越权自查)，在 WebUI action 路径(`setUser`)却可直接设 owner。当前唯一防线是 webui 未登录默认可信（与新功能 #1 登录界面挂钩）。
   - 🎯 重新设计方向：**以插件内的抽象能力(capability)为中心**——敏感操作在操作边界统一 `authority.require(identity, capability)` 检查，任何 surface 进来都过同一闸；`ExecutionGuard` 退化为 tool/command surface 的适配器。前置依赖：身份贯通（每个 surface 携带调用者 platform/userId；WebUI action 当前缺失），与登录/scoped 沙盒(#1)合并设计。
4. ~~当前PDF解析器有问题，对于科学文档（LATEX转译）似乎有识别问题，考虑更新识别库~~ ✅ 已修复：`plugin-file-reader` 原用 `pdf-parse@1.1.1`(2019 停更，包裹老旧 pdf.js fork，文本拼接朴素无版面重建，import 时还跑测试文件)。换为 `unpdf`(维护中的 pdf.js 封装，带版面重建，科学/LaTeX 文档文本质量更好；自带 serverless 构建可移植到 worker；并提供 `renderPageAsImage` 为后续「PDF 页渲染→视觉模型 OCR」铺路)。改动隔离在单个 `extractPdf` 函数，已用手工 PDF 真实验证提取成功。
5. ~~当前webui多人使用时，会因为其他人新开会话/在别的会话聊天，而切换上一个人当前的会话窗口，或许做一下隔离？~~ ✅ 已修复：根因是 session-manager 持有**单一全局 `activeSessionId`**，webui 的 `switchSession` 动作会改它并 `emit('session:switched')`，webui-server 再**广播给所有客户端**强制切换。但 webui 入站消息其实自带 sessionId，全局指针根本不参与路由，纯属 CLI 时代遗留。解耦：①webui-server 移除 `session_switched` 跨客户端广播；②`switchSession` action 不再驱动全局指针(降级为幂等确认)；③前端每客户端用 localStorage 持久化自己的活跃会话，init 从 localStorage 恢复而非读服务端全局。现每个 webui 客户端各自独立，多人互不干扰。
6. ~~通过左侧会话管理新建会话方式，会导致新建的会话都是永远的进行中，直到发生对话并完成；同时会话中途中断agent，也是永远的进行中~~ ✅ 已修复：同根因。①新建空会话初始状态由 `active`(进行中) 改为 `waiting`(等待中)；②agent 现在在中止/异常路径也发 `agent:turn:after`(outcome=aborted/error)，session-manager 新增该钩子的生命周期收口，把根会话从 `active` 收口为 `completed`（与 `outbound:message` 幂等互补），覆盖中止/静默两种无 outbound 的终态。附带修复 checkpoint 中止后回合不关闭的泄漏。
7. ~~检查是否还有对存储的裸读取~~ ✅ 已审查：所有 storage 托管数据（权限用户表/人设/调度任务/向量库/上传文件/token/todo/file 工具等）均已走 storage 网关，无不当裸读取。仅剩的直接 `fs` 读取均为合法豁免：bootstrap 配置加载(storage 插件尚未起)、运行时日志文件 `data/latest.log`、storage-local 后端自身、`readExternalFile` 显式外部逃生口、浏览器二进制探测、前端 dist 静态托管。附带收口：日志单行序列化契约(`formatLogLine`/`parseLogLine`)原本在 runtime/cli/webui-server **各抄一份**(file-logger 虽导出 `parseEntry` 但下游未复用，因 `src/runtime` 非可导入包)，现统一收口到 `@aalis/core`(纯函数零 I/O，与 LogHub 同层)，三处复用同一权威，杜绝格式漂移。

- 新功能计划
1. 考虑开始兴建 scoped/app 沙盒，为不同scope的webUI提供不同的权限等级与可见性/乃至引入登录界面，可以作为类似chatGPT/claude分发
2. 商店还没正式开始制作
3. 允许进行文档内图片识别
4. onebot 信息撤回 / 知道对方信息是否被撤回了？
5. 按会话/时间/前多少到多少条取最近信息（当前应该有会话没时间限制）

- 考虑对插件重新进行统一安全与漏洞检查，当前各种位置潜在bug很多，考虑制作插件市场并在这个过程中重新审阅每个插件潜在的问题，甚至在这个过程中着手从头重写逻辑


- 介于你的子代理经常出现幻觉，不要过于相信，建议你多亲力亲为地进行全面审查，分析与操作。同时你的记忆也早已过时，需要你亲自进行代码审查

- 如果你拿不准，有建议，或者是有其他问题，请你使用你的问题工具向我询问，我们一起协商敲定解决与修改方案。但你不要擅自停止推理，你有问题就使用问题工具，不要停止推理或改动，形成类似交互式的处理。完成修改后尝试测试，CI/CD，提交与推送