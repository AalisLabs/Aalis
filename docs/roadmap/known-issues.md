# 已知问题 — 一次大规模对抗审计的产物

2026-08 一批改动（市场重构 / 指令声明栈 / metadata 契约 / 两次包改名）之后，跑了四轮对抗
审计（合计约 50 个 agent）。本文记录**经实测确认、但当轮未修**的条目。

体例与本目录其余文档一致：每条附实测依据与当前位置；**不附行号**——这批文档上一次就是因为
行号整体漂移而失准（重构后 4 处引用全错），行号请以符号名现场 grep 为准。

> ⚠️ 本文里的判断来自审计 agent + 作者复核。凡标「未复核」的，动手前请自己先复现一遍——
> 这批工作里，未经复现就采信的结论出错过多次。

## 一、结构性：同一语义的多份实现

这是本批出问题最多的一类，已出事四次（依赖来源判据、定级数学、包名正则、关键词分类）。
前两次已收敛（合并进 `util-dep-spec` / `api-authority`），后两次仍在。

### 权限定级散在三处，其中两处不该有

**现状**：`(risk, visibility) → 最低等级` 这条判定活在三个地方——
`api-authority` 的 `capabilityMinLevel`、`plugin-authority` 的 `resolveMinLevel`（包一层
overrides）、`plugin-webui-client/src/pages/authority-page-util.ts` 的 `derivedMinLevel`
（**自带一份，对 `@aalis/api-authority` 零引用，`0/1/2` 硬编码**）。

三份当前**行为一致**（实测五组输入全部相同），漂移是潜在的而非已发生。但改一次
`RESTRICTED_LEVEL` 或加一档 risk，后端立刻跟随、权限页仍显示旧值——而那正是 owner 唯一
看得见裁决结果的界面，且没有任何测试或类型会报错。

**溯源（重要）**：WebUI 那份**早于本批工作**就存在，不是这次引入的。本批引入的是把
`capabilityMinLevel` 从 `plugin-authority` 私有**抬进 `api-authority` 公开导出**并让
`plugin-commands` 消费——那治好了后端两份的漂移，代价是把「权限判定可以住在别的插件里」
从一个 bug 变成了一个接口。

**方向（未定）**：让服务端下发算好的 `minLevel`，前端纯渲染——与市场页「服务端算 `updatable`、
前端不自算」同构（那条路已经因为两份判据出过两类实测错，教训是现成的）。更彻底的做法是
让 `plugin-commands` 也别定级：它现在为了合并同名声明与祖先链而必须比较「谁更严」，而
`ExecutionGuardContext` 的契约又要求「注册时已展开成生效值」。要根治得让 commands 只交
**声明链**、由 authority 合并并裁决——那是 `api-authority` / `api-commands` / `api-tools`
三个契约包的 breaking change，牵动五个包。**没做，因为改到一半比不改更糟。**

### 「关键词 → 包类型」四份实现，已实测分歧

`plugin-package-manager` 的卸载闸（一串中文三元）、`marketplace.ts` 的 `classifyPackage`
（interface > api > schema > util > **兜底 plugin**）、同文件的 `classifySystemComponent`
（core > runtime > api > schema > util，插件返回 undefined）、`node-modules-loader.ts` 的
`isLoadablePlugin`（只看 `aalis-plugin`）——四者优先级各不相同。

**实测两处分歧**：
- 同时带 `aalis-plugin` 与 `aalis-api` 的包 → 加载器**会**加载它，市场页却渲染成只读
  「API 契约」卡片（无装卸按钮），系统组件页还多一张只读卡。仓库记忆里「tools-api 误带
  关键词」正是这一形态，发生过一次。
- 无任何 aalis 关键词的包 → `classifyPackage` 兜底成 `plugin`（前端渲染卸载按钮），
  而服务层闸判「非插件包」拒绝。两侧对同一输入结论相反。

**方向**：抬成唯一一份纯函数，三处调用同一份；`aalis-plugin` 必须最优先（它是加载器的判据，
其余必须与加载器一致，否则界面说的和运行时做的是两回事）。

### 包名正则仍是两份且字节完全相同

`marketplace.ts` 的 `PKG_NAME_RE` 与 `plugin-package-manager` 的 `PKG_SPEC_RE` 逐字符相同，
而两处注释分别写着「路由不再自带第二份」「**只有这一份实现**」——**两句在当前代码上都是假的**。

留下的那份也没适配新用途：注释说它现在挡的是 URL 路径段注入，但正则仍接受 `@version` 后缀，
于是 `depgraph?name=foo@1.2.3` 通过校验、拼出必然 404 的 packument URL、被 catch 静默吞掉，
前端得到一张空依赖图而不是 400。

## 二、改了契约没回改调用侧

已出事三次（`commitMetadata` 的原子性表述、`PackageManagerService` 的 JSDoc、
`packagesDir` 的死代码）。剩余：

- **`metadata` 四方法必填后，测试侧四处守卫与一句用户可见文案没跟上**。生产侧八处死守卫已
  删净，但 `plugin-maimai` 仍返回「绑定失败：记忆服务未提供 saveMetadata」——一个契约上已
  不可能发生的原因，会把人引去查 memory 插件的实现而不是查服务是否启用。测试侧四个文件
  仍在守恒真式（`if (!mem.saveMetadata || ...) throw`）与死非空断言（`saveMetadata!(...)`）。
  **复查纪律**：契约从 optional 改 required 时，除了 grep 符号名，还要 grep 该条件的**中文
  表述**（「未提供」「不支持」「缺少」+ 能力名）——那类字符串不含被删的符号，按符号 grep 抓不到。
- **`api-memory` 的必填化只做了 4/11**：另 7 个方法（`clearAll` 等）用的是同一条论据
  （三家后端全实现），却仍是可选。要么补齐要么说明为何这 4 个特殊。
- **`unregister` 加了 `pluginName` 参数**，但 `api-commands` 那条通路唯一的测试替身仍是旧
  单参签名——改回单参也不会红。

## 三、性能：真正的大头没动

**级联删除每删一个节点付 2 次全表读**（`deletePersonCascade` / `deleteEventCascade` /
`deleteEntityCascade`）。实测量级：1400 次全表读 vs 快照缓存当初省下的 1 次。

本批花三个提交（TTL / 冻结 / 12 处 invalidate）去省那 1 次，最后整个删掉改用既有的
`_snapshot` 线程化；而这 1400 次一直没人看。**若要再动 user-relation 的性能，这里才是。**

## 四、复杂度：这批工作不是「精简」

三个 agent 独立统计得到同一结论：**源码代码净 +161 行、注释净 +355 行，文档净 -307 行**——
markdown 里删掉的理由几乎一比一搬进了源码注释。「精简」只发生在 `docs/`。

具体的注释膨胀点（建议压缩，非缺陷）：
- `api-memory` 的「结构化元数据存储」块注释占该文件 17%，其中 benchmark 数字与 ORM 选型
  不属于契约。
- `SPEC_ARGV_BUDGET` 用 16 行论证 `execve` 的 ARG_MAX，注释自认「任何真实实例都够不到」，
  理由还在调用点复述一遍。
- 「rehype-raw 被实测推翻」这段历史叙事在两个文件里各写了一遍。

**教训**：把结论从 roadmap 搬进代码注释，并不自动解决陈旧问题，只是换了个陈旧的地方——
本批实测到 `help.ts` 的文件头注释比 roadmap **更**失准。真正管用的是改动时回头核对相关注释。

## 五、零散（低）

- **`isSymmetricRelation`**：零生产调用点、靠自己的单测续命、knip 看不见——与已删的
  `parsePackInfo` 同形。
- **幽灵分组回收只挂在 `unregisterByPlugin`**，直接 `unregister` 仍留幽灵（契约面不对称；
  真实卸载路径走前者，故非活缺陷）。
- **别名在 `materialize` 里只取栈顶**：底层声明的别名解析得到却不展示。
- **`ctx.provide` 收 `unknown`**，`ServiceTypeMap` 的声明不校验实现——补 declare 只解决了
  消费侧手抄类型，提供侧写错依然不报错。
- **25 包改名后**，vitest 覆盖率排除项与约 20 处文档/core 源码注释仍写旧命名。
- **`koishi-compat.md`** 仍引用已删除的 `packagesDir()` 并给出失效行号；该文所有 Aalis 侧
  事实都需要在实施前重核（包名、指令系统机制、市场关键词数量均已变）。

## 六、待决策（不是缺陷）

- **指令声明栈是否该回退**成「同名注册直接拒绝」。两个 agent 结论相反：一个认为它「服务的是
  本仓从未发生的条件」（实测 42 个指令名最大重数为 1、全仓 0 处 `.alias()`）、回退可省 66 行；
  另一个认为代码增量只有 +28 行、不值得回退。**未定。**
- **预检副本是否该回退**。实测「环境变量在 live tree 就能翻掉项目级 `.npmrc`」，所以副本对
  那条缺口是零增量；但副本对另一条缺口（`--dry-run` 污染隐藏锁）是必需的。副本同时引入了
  新问题：丢掉项目 `.npmrc` 的 registry / authToken，**私有源用户的预检对着另一个 registry
  下结论**。最小修法是把项目 `.npmrc` 一起 cp 进副本（实测 env 仍能压过它）。
- **25 个契约包改名是否划算**。一个 agent 判「不划算」。已发布，回滚代价更大，**不回退**，
  但记在此处以免后来者以为这是无代价的决定。

## 相关文档

- 安全模型：[`docs/concepts/security-model.md`](../concepts/security-model.md)
- 服务模型：[`docs/concepts/service-model.md`](../concepts/service-model.md)
