# 已知问题

2026-08 一批改动之后跑了四轮对抗审计，又跑了一轮**对那份记录自身的对抗核实**（42 个 agent），
据此修掉一批、更正一批失实数字。本文只留**当前仍未解决**的。

体例：位置写符号名不写行号（行号会随重构整体漂移而静默失准）；每条附实测依据。

> ⚠️ 凡本文的判断，动手前请自己先复现一遍。上一版本文自己就有五处失实，来源都是
> 「未经复现就采信」。

## 一、权限定级：WebUI 自带第二份

`api-authority` 的 `capabilityMinLevel` 是后端唯一实现；`plugin-webui-client` 的
`derivedMinLevel` 是拷贝——对 `@aalis/api-authority` 零引用、`0/1/2` 硬编码。

**已实测的分歧**：枚举 risk × visibility 全组合，契约域内 12 组全同，域外 3 组分歧，形如
「risk 是非联合成员的真值串 + `visibility:'restricted'`」：后端 2、前端 0。根因是结构不同
——后端三个 `===` 都不中才落 visibility 兜底，前端是 `if (op.risk) return riskToLevel(op.risk)`，
只要 risk 为真就再也不看 visibility。方向是 fail-open 的显示：第三方插件把 `risk` 拼错，
权限页会显示「所有人可用」。

**测试挡不住漂移**：把 `RESTRICTED_LEVEL` 由 2 改 3，8 个后端用例变红、前端那 7 个全绿，
而红的都是「后端函数 vs 字面量 2」，改字面量即转绿，漂移被「测试已修好」的假象盖住。

**修法与代价（两人独立实测，数字一致）**：`getOverview` 对每条 operation 多下发一个后端算好
的 `minLevel`（payload 已在发 `risk`/`visibility`，加 3 行代码 + 2 行注释），前端删掉自己那份
（`riskToLevel` / `derivedMinLevel` 共 10 行），`effectiveMinLevel` 只留 override 覆盖。
全量 13 文件 +52/−63，其中 src 只有 4 文件 +10/−25。同批可顺手删掉 `plugin-authority` 的死
`riskToLevel`（3 行转发壳、零生产调用点，但有 6 处文档引用它，要一并改）。

**唯一真风险**：`plugin-webui-client` 与 `plugin-authority` 是两个独立 semver 的包、彼此无
依赖边（前端不能依赖 api-authority）。新前端配旧 authority（不发 minLevel）时 `op.minLevel`
为 undefined，页面显示 `默认undefined`——不崩、不影响实际权限（该值纯显示、从不回写，
`setOpLevel` 送的是用户手输的整数）。**不要**用 `?? 0` 兜底：那正是本条要修的 fail-open。
两包同批 bump + publish 即可。

## 二、性能：关系图仍有 8 次全图读

热路径固定的那 2 次已合并（提取一轮只读一次，已钉进测试）。剩下的随节点/边数**线性增长**：
`createEvent → findEventByTitle` 每个新事件 1 次、`createEntity → findEntityByKindAndName`
每个新实体 1 次、`addPersonEventEdge` / `addPersonEntityEdge` / `addPersonPersonEdge` 每条边
各 1 次，其中 **`addPersonPersonEdge` 同一方法内读两次是纯冗余**（自身一次 +
`findPersonPersonEdge` 再一次）。审计实测典型一轮共 10 次、六种边全覆盖 13 次。

单次 `listMetadata('user-relation')` 在生产图上中位 **177ms**（3352 文档 / 38.7MB，mongodb）。
**最该先动的是 `addPersonPersonEdge` 那次重复**，它零风险且不改调用契约。

## 三、零散（低）

- **`ServiceOf` 零消费者**：core 导出但全仓无人用。要么用起来（收口 `provide` 的第二个参数，
  实测能抓住三种写错、放行 router 模式的动态名），要么按本仓的死代码标准删掉。
  **属新增约束，不是修 bug**，需先拍板。
- **`koishi-compat.md` 已失准**：384 行里 23 处引用（`packagesDir()`、旧 api 包名、18 处行号）
  已对不上当前代码。它是**未开工的计划**，不是缺陷——实施前须整篇重核。
- **`docs/roadmap/commands.md` 的行号体例**：实测 17 处行号引用里 10 处已指向别的代码
  （指令系统被重写过四次）。按本目录现行体例应改写成符号名。

## 四、尝试过并回退的（避免后来者重走）

**预检副本不 cp 项目 `.npmrc`**，导致私有源用户的预检对着公共源下结论（包只在私有源上就
404/401 → 更新被永久挡住且报错文不对题）。实做后被 `test/integration/install-chain.test.ts`
的真实 npm 用例推翻：带上 `.npmrc` 后 `legacy-peer-deps=true` 那道护栏失效，**而隔离复现里
env 明明压得过项目级 `.npmrc`，机制未查清**。已回退。要重做的话先解释清楚这个矛盾。

## 五、待决策（不是缺陷）

- **指令声明栈是否该回退**成「同名注册直接拒绝」。事实前提：本仓实际注册点 48 条、互不重名；
  `.alias()` 生产 0 处、测试 9 处（回退成本要算上改测试）。行数三个口径：源码净 +71 行
  （其中注释 +49、代码 +20），测试 +149 行。注意威胁模型是**第三方插件**注册同名指令提权，
  本仓 0 重复本就是预期，不构成「服务的是从未发生的条件」的反驳。
- **25 个契约包改名是否划算**。已发布，不回退，记此以免后来者以为无代价。

## 相关文档

- 安全模型：[`docs/concepts/security-model.md`](../concepts/security-model.md)
- 服务模型：[`docs/concepts/service-model.md`](../concepts/service-model.md)
