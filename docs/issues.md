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