# 插件清单元数据：两套独立元数据源（manifest metadata）

**适用对象**：写/维护 Aalis 插件的第三方作者。
**相关源码**：
`packages/runtime/src/node-modules-loader.ts`（npm 部署的发现/加载器）、
`packages/runtime/src/providers.ts`（monorepo 目录扫描加载器 `createFsPluginLoader`）、
`packages/core/src/app.ts`（`autoLoadPlugins` —— ESM namespace → `PluginModule`）、
`packages/core/src/types/plugin.ts`（`PluginModule` 类型）、
`packages/core/src/plugin-activation.ts` / `plugin-topology.ts`（运行时 DI 怎么用 `provides`/`inject`）、
`packages/plugin-webui-server/src/routes/marketplace.ts` + `src/client-discovery.ts`（怎么读 `package.json` 的 `aalis.*`）。

## 概述：为什么插件作者要关心它

一个 Aalis 插件其实把元数据写在**两个互不相通的地方**，它们由**不同的代码、在不同的时间**读取：

| 源 | 写在哪 | 谁读 | 何时读 | 干什么 |
|---|---|---|---|---|
| **A. 运行时 DI 源** | 模块导出 `export const provides` / `export const inject`（或 `apply` 同模块字段） | **core**（`PluginManager` / `plugin-topology` / `plugin-activation`） | 插件**已安装并加载进进程后** | 拓扑排序、激活门控、provides 校验 |
| **B. 安装前披露源** | `package.json` 的 `aalis.service.{provides,required,optional}` | **webui-server 的市场路由** | 插件**还在 npm 上、尚未安装时** | 给用户看「装它会引入/需要哪些服务」 |

关键事实：**core 永远不读 `package.json`，市场永远不读运行时导出。** 两套源没有任何一处代码把它们对账，
所以它们**可能漂移、且确实漂移过**（见下文「审计标注的漂移」）。作为作者，你要把两边手动写成一致——
这是本文要解决的核心问题。

除了这两套服务元数据，`package.json` 上还有几个**纯关键词/标记**门：`keywords` 里的类型词（`aalis-plugin`
等）决定「能不能被当插件加载」「在市场归到哪一类」，`aalis.client` 决定「能不能被当前端发现」。这些也在本文一并讲清。

> 运行时 DI 的**语义**（`required` vs `optional` 怎么选、`provides` 的拓扑约定、bounce）已在
> `docs/plugin-author-guide.md` 第 2–3 节详述，本文不重复，只讲「两套源如何各自被读取、必须一致」。

---

## 源 A：运行时 DI 元数据（core 读）

### 加载器只认 ESM namespace 上的字段

加载器（`createNodeModulesPluginLoader` 或 `createFsPluginLoader`）`import()` 你的入口模块后，把
**整个 ESM namespace 对象**直接当成 `PluginModule`（`node-modules-loader.ts:89-91`、`providers.ts:262-265`）：

```ts
async load(desc): Promise<PluginModule | null> {
  return (await import(pathToFileURL(desc.source).href)) as PluginModule;
}
```

所以你的入口文件用 `export const xxx` 导出的每个具名导出，就是 `PluginModule` 的对应字段。`autoLoadPlugins`
随后只检查两个必备字段就接受它（`app.ts:213-214`）：

```ts
if (!mod || typeof mod.apply !== 'function' || !mod.name) {
  this.logger.debug(`跳过非插件模块: ${desc.name}（缺少 name 或 apply）`);
  continue;
}
```

即「有 `apply` 函数 + 有 `name`」即视为插件。其余字段（`provides` / `inject` / `displayName` /
`reusable` / `core` / `configSchema` / `defaultConfig` / `requiresBounceOnDepChange`）全是可选的运行时元数据，
定义见 `PluginModule` 接口（`core/src/types/plugin.ts:15-55`）。

典型入口头部（`@aalis/plugin-storage-local`，`src/index.ts:19-25`）：

```ts
export const name = '@aalis/plugin-storage-local';
export const displayName = '本地存储根（命名 + 路径解析）';
export const subsystem = 'storage';
export const provides = ['storage'];
export const inject = {
  optional: ['doctor'],
};
export function apply(ctx, config) { /* ... ctx.provide('storage', ...) */ }
```

### `inject` —— 激活门控 + 拓扑入边

`PluginManager.register` 读 `module.inject`，把 `required`/`optional` 归一成依赖（`plugin.ts:106-108`）：

```ts
const inject = module.inject ?? {};
const requiredDeps = (inject.required ?? []).map(normalizeDependency);
const optionalDeps = (inject.optional ?? []).map(normalizeDependency);
```

- `required` 的每个服务名必须都 `hasService` 才会激活（`plugin-activation.ts:59-64`），且参与拓扑建图（`plugin-topology.ts:43-53`）——provider 先起、consumer 后起。
- `optional` **不**参与拓扑建图（避免互相 optional 造伪环，`plugin-topology.ts:23-25`），靠 `service-up`/`service-down` 的 reactive recompute 补救。

`inject` 的元素是 `string | { service: string }`，**只有服务名**——0.5.0 起没有 capability 维（`InjectDeclaration`，`core/src/types/core.ts:14-23`）。

### `provides` —— 拓扑权威提供者 + 激活后校验

`module.provides` 被 core 用在三处：

1. **拓扑排序**取「服务名 → 首个声明提供它的 entry」建图（`plugin-topology.ts:30-35`）。
2. **激活后必达校验**：`apply` 跑完后，core 检查 `provides` 里每个名字是否真的被 `ctx.provide` 注册了，缺一个就把插件打成 `error`（`plugin-activation.ts:75-82`）：

   ```ts
   if (entry.module.provides) {
     const missing = entry.module.provides.filter(
       name => !rootCtx.serviceContainer.hasByContext(name, entry.instanceId),
     );
     if (missing.length > 0) {
       throw new Error(`声明 provides [${missing.join(', ')}] 但未实际注册这些服务`);
     }
   }
   ```

3. **dev-mode 反向检查**：实际 `ctx.provide` 了但没在 `provides` 里声明的服务名会 warn「下游依赖排序将无法找到该 provider」（`plugin-activation.ts:87-99`）。

**结论：源 A 的 `provides` 必须和你 `apply` 内 `ctx.provide(...)` 的服务名集合完全一致**，否则 dev 模式 warn、或激活直接失败。语义细节见 `docs/plugin-author-guide.md` 第 3 节。

> 注：`provides`/`inject` 不一定要写成 `export const`——只要它们出现在 ESM namespace 上即可。但约定俗成、也最易读的是顶层 `export const`，全体内置插件都这么写。

---

## 源 B：`package.json` 的 `aalis.service`（市场读）

这块**纯给安装前披露用**，core 完全不感知。市场路由从 **npm registry 的 packument**（而非已装的本地文件）读 latest 版本的 `aalis.service` 和依赖名（`marketplace.ts:196-214`）：

```ts
export function toManifest(packument): PluginManifest | null {
  const latest = packument['dist-tags']?.latest;
  if (!latest) return null;
  const v = packument.versions?.[latest];
  const dependencies = [...new Set([...Object.keys(v?.dependencies ?? {}), ...Object.keys(v?.peerDependencies ?? {})])];
  return { name: '', version: latest, description: v?.description, service: v?.aalis?.service, dependencies };
}
```

`PluginManifest.service` 的形状（`marketplace.ts:66-73`）：

```ts
service?: { required?: string[]; optional?: string[]; provides?: string[] };
```

写法（`@aalis/plugin-scheduler/package.json`）：

```jsonc
{
  "name": "@aalis/plugin-scheduler",
  "keywords": ["aalis", "aalis-plugin"],
  "aalis": {
    "service": {
      "required": ["tools", "cron-engine"],
      "optional": ["agent"],
      "provides": ["scheduler"]
    }
  }
}
```

它的作用：用户在 WebUI 市场点开一个**还没装**的包，前端展示「装它会新增 `scheduler` 服务、需要你已有 `tools`/`cron-engine`、可选用 `agent`」。装之前 core 拿不到运行时导出（包都还没下载），**只能**靠 `package.json` 这份静态声明做知情决策。

> `aalis.service` 与「装后」披露不是一回事：插件**装好之后**的能力披露走 `/api/plugins`，那条路读的是 core 状态里的运行时 `provides`/`requiredServices`（`plugin-webui-server/src/routes/plugins.ts:59-62`），即源 A。所以源 A 漂移会让「装前/装后」披露不一致。

---

## 两套源必须一致（这是本文的核心纪律）

**手动**让源 A 与源 B 表达同一组服务关系：

| 源 A（运行时导出） | 源 B（`package.json`） |
|---|---|
| `export const provides = ['scheduler']` | `aalis.service.provides = ["scheduler"]` |
| `inject.required = ['tools', 'cron-engine']` | `aalis.service.required = ["tools","cron-engine"]` |
| `inject.optional = ['agent']` | `aalis.service.optional = ["agent"]` |

`create-aalis-plugin` 脚手架对此有显式提示（`cli.ts:188-189, 214-215`）：

```jsonc
// 有服务依赖/提供时在此声明，市场据此做安装前能力披露：
// aalis: { service: { required: ['llm'], optional: ['memory'], provides: ['my-service'] } }
```

> 注意脚手架生成的 `package.json` **根本不带 `aalis` 字段**（示例插件无服务依赖；模板里只留了一行
> 注释提示该往哪写，`cli.ts` renderPackageJson），生成的 `index.ts` 也仅 `export const inject = {}`（`cli.ts:302`）。
> 你一旦在 `apply` 里 `ctx.provide(...)` 或在 `inject` 里加依赖，就要**同步把它写进 `package.json` 的 `aalis.service`**，否则市场披露会缺项。

---

## 审计标注的漂移（真实存在的 bug，引以为戒）

把全部内置插件的两套源跑过一遍对账（`provides`/`required`/`optional` 归一去重后逐项比），发现了几处**真实漂移**，全部是「源 A 有、源 B 缺」——即运行时确实做了，但市场装前不披露：

### 1. ASR 插件漏报 `provides`

`@aalis/plugin-asr-openai`、`@aalis/plugin-asr-whisper-cpp` 运行时都导出 `provides = ['asr']`
（两者 `inject` 形态不同——openai 是 `optional`、whisper-cpp 是 `required`，但都提供 `asr`）：

```ts
// plugin-asr-openai/src/index.ts:19-20
export const provides = ['asr'];
export const inject = { optional: ['process', 'storage'] };

// plugin-asr-whisper-cpp/src/index.ts:23-24
export const provides = ['asr'];
export const inject = { required: ['process', 'storage'] };  // 注意：required，非 optional
```

但它们的 `package.json` `aalis.service` **只有依赖、没有 `provides`**：

```jsonc
// plugin-asr-openai/package.json
"aalis": { "service": { "optional": ["process", "storage"] } }   // 缺 "provides": ["asr"]
```

后果：用户在市场看不到「装这个包会新增 `asr` 服务」，依赖 `asr` 的插件（如 `plugin-media` 的 `optional: ['asr']`）就没法在装前被正确串联。**修法：给两个包补 `"provides": ["asr"]`。**

### 2. webui-server 的 `optional` 反向多报

`@aalis/plugin-webui-server` 的 `package.json` 把 `session-confirm` 列进 `aalis.service.optional`：

```jsonc
"aalis": { "service": { "optional": ["storage","authority","commands","platform","process","session-confirm"], ... } }
```

但运行时 `inject.optional` **没有** `session-confirm`（`src/index.ts:55-62`）：

```ts
export const inject = {
  optional: ['storage', 'authority', 'commands', 'platform', 'process'],   // 无 session-confirm
};
```

这是「源 B 多、源 A 少」——市场披露一个运行时根本不 inject 的依赖。（webui-server 可能在别处用 `whenService('session-confirm')` 间接消费，但那不进 `inject`，披露口径就该按 `inject` 走。）**修法：让两边对齐——要么从 `aalis.service` 删 `session-confirm`，要么补进 `inject.optional`，取决于它是否真是一个 inject 依赖。**

这两处说明漂移**两个方向都会发生**，且没有任何自动化拦得住——直到你加 CI 检查（见下）。

---

## 类型/标记门：`keywords` 与 `aalis.client`

除了服务元数据，`package.json` 还有几个**判定门**，决定一个包**是不是**插件、归哪一类、能不能当前端。

### `keywords` 类型词 —— 加载门 + 市场分类

**唯一的「这是不是可加载插件」判据是 `keywords` 含 `'aalis-plugin'`**（`node-modules-loader.ts:35-38`）：

```ts
export function isLoadablePlugin(meta: Record<string, unknown>): boolean {
  const keywords = Array.isArray(meta.keywords) ? (meta.keywords as string[]) : [];
  return keywords.includes('aalis-plugin');
}
```

两个加载器（npm 部署 / monorepo 扫目录）共用这一个纯函数（`providers.ts:249-251`），保证单一真相、不漂移。每类包打**各自**的类型词，互斥：

| 包类型 | 类型关键词 | 会被当插件加载？ | 市场归类 |
|---|---|---|---|
| 功能插件 | `aalis-plugin` | ✅ | `plugin` |
| 契约/SDK（`*-api`） | `aalis-api` | ❌ | `api` |
| 前端界面 | `aalis-interface` | ❌ | `interface` |
| 工具库（`util-*`） | `aalis-util` | ❌ | `util` |
| 核心 / 工具链 | `aalis-core` / `aalis-runtime` | ❌ | （不进市场检索四类） |

市场按类型词分类（`marketplace.ts:82-87` 的 `classifyPackage`），四类各发一条 npm 检索再合并（`AALIS_KEYWORDS = ['aalis-plugin','aalis-util','aalis-api','aalis-interface']`，`marketplace.ts:16`；逗号是 AND 不能合并，见 `buildSearchUrl`）。

**因此：你的功能插件 `package.json` 必须有 `keywords: ["aalis-plugin"]`，否则两个加载器都不会发现它**——这是比 `aalis.service` 更硬的门（脚手架默认就带，`cli.ts:197`）。

### `aalis.client: true` —— 前端发现门（功能性，会被读）

前端包用 `aalis.client: true` 标记自己是一个 WebUI 前端候选，被 `discoverClients` 读取（`client-discovery.ts:44`）：

```ts
if (!pkg || pkg.aalis?.client !== true || typeof pkg.name !== 'string' || seen.has(pkg.name)) return;
```

收录条件是 `aalis.client === true` **且** `dist/index.html` 存在（`client-discovery.ts:46`）。`@aalis/plugin-webui-client` 即标了 `aalis.client: true` + `keywords: ["aalis-interface"]`。这是少数几个**被代码真正读取**的 `aalis.*` 字段之一。

### `aalis.util: true` —— 注意：这是个「死字段」，别依赖它

工具库包（如 `@aalis/util-network-guard`）的 `package.json` 里有 `aalis: { util: true }`，但**没有任何代码读取 `aalis.util` 这个字段**——市场把一个包归为 `util` 类靠的是 `keywords` 含 `'aalis-util'`（`marketplace.ts:85`），不是这个 marker。

所以 `aalis.util` 目前是纯装饰性的、与 `aalis.client`（被读）形成对照。**别把任何行为挂在 `aalis.util` 上**——它不会触发任何逻辑。要让工具库进市场 `util` 类，靠 `keywords: ["aalis-util"]`。

---

## 推荐：加一条 CI 对账检查

既然没有任何运行时代码强制源 A == 源 B，唯一可靠的防漂移办法是 **CI 比对**。思路（已用同样逻辑在本仓库手动跑出上面那两处漂移）：

1. 遍历每个 `keywords` 含 `aalis-plugin` 的包；
2. 从 `package.json` 取 `aalis.service.{provides,required,optional}`（源 B）；
3. 从 `src/index.ts`（或编译产物 `dist/index.js` 的 namespace）取 `provides` / `inject.{required,optional}`（源 A）；
4. 各项归一（去重 + 排序，`{service}` 对象取 `.service`）后逐项相等比对，不等即 fail，打印 `manifest=… runtime=…`。

> 比对源 A 最稳的方式是 `import()` 编译后的入口拿 namespace，而非正则扫源码——正则会被嵌套数组（如 tool 定义里的 `required: ['urls']`）误命中。本仓库手动对账时正则版就报过这类假阳性，真值确认须读编译后的导出。

把它挂进 `ci:local`，新增/改插件时就能在提交前发现「`ctx.provide` 了新服务却忘了同步 `aalis.service.provides`」这类漏报。

---

## 陷阱 / 边角案例小结

1. **两套源不自动对账**。core 不读 `package.json`，市场不读运行时导出——必须手写一致，靠 CI 兜底。
2. **`provides` 必须 == `ctx.provide()` 实际注册的服务名**。少声明 → dev warn / 拓扑排不到你；多声明 → 激活后校验失败打成 `error`（`plugin-activation.ts:75-82`）。
3. **市场读的是 npm packument 的 latest 版本**（`toManifest`），不是你本地工作区——所以 `aalis.service` 改了得**发版**才在市场生效。
4. **`keywords: ["aalis-plugin"]` 是加载硬门**。漏了它，插件永远不被发现，`aalis.service` 写得再全也没用。
5. **`aalis.client` 被读、`aalis.util` 不被读**。前者控制前端发现，后者是死字段；归类靠 `aalis-util` 关键词。
6. **`extends_` 的 ESM 键名陷阱（当前是 no-op）**：见下节。

---

## `extends_` 的 ESM 键名陷阱（当前是 no-op，需警惕）

`@aalis/plugin-webui-api` 通过 declaration merging 给 `PluginModule` 注入了一个纯展示字段 `extends`，让插件声明「我给 core 加了哪些事件/钩子/mixin」供前端「扩展 Core」标签渲染（`plugin-webui-api/src/index.ts:191-192`、`ExtendDeclaration` 在 `:260-267`）。webui-server 直接从 `module.extends` 读它并转发前端（`plugins.ts:70`）：

```ts
extends: pm.getPlugin(p.instanceId)?.module?.extends,
```

但 `extends` 是 JS **保留字**，不能写成 `export const extends = …`。于是 webui-api 的文档示例教作者用**带下划线**的 `extends_`（`plugin-webui-api/src/index.ts:254-258`）：

```ts
export const extends_: ExtendDeclaration = {
  events: ['scheduler:tick', 'scheduler:error'],
  hooks: ['schedule:before'],
};
```

真实插件也确实这么写了（`plugin-scheduler/src/index.ts:130`、`plugin-workflow/src/index.ts:38`）。

**问题：ESM namespace 上的键名是 `extends_`（带下划线），而消费端读的是 `module.extends`（不带下划线）。**
加载器把 namespace 原样当 `PluginModule`（不做任何 `extends_` → `extends` 的改名），所以 `module.extends` 永远是 `undefined`——**这些 `export const extends_` 当前完全不生效（no-op），前端「扩展 Core」标签拿不到数据**。

作者须知：
- 现在写 `export const extends_` 不会报错、也不会有任何效果。别误以为它生效了。
- 要让它真正生效，需要**有一方做改名**：要么消费端读 `module.extends ?? (module as any).extends_`，要么加载器/webui-api helper 把 `extends_` 归一到 `extends`。在此之前，`extends` 仅是「写了好看」的元数据。
- 这也是「源 A 字段名」与「消费端读取名」错配的一个典型案例——和服务元数据漂移同源，都是**没有契约校验把两端钉死**导致的。

---

## 交叉链接

- 运行时 DI **语义**（`required` vs `optional` 怎么选、`provides` 拓扑约定、bounce、`requiresBounceOnDepChange`）：`docs/plugin-author-guide.md` 第 2–3.5 节。
- DI 服务模型（同名多 provider 选优 preference > priority > 注册序、per-entry 粒度、`getService`/`provide` 仅取 name）：`docs/core/service.md`（forward-ref）。
- 存储 URI 文法（per-root entryId 约定 `${ctx.id}/${root.name}`，作为 per-entry provides 粒度的范例）：`docs/concepts/storage-uri-grammar.md`。
- 插件类型关键词门与市场四类分类的来龙去脉：`packages/runtime/src/node-modules-loader.ts`、`packages/plugin-webui-server/src/routes/marketplace.ts`。
- 安装后能力披露（与安装前 `aalis.service` 对照）：`docs/services/webui.md`（forward-ref，`/api/plugins` 读运行时 `provides`/`requiredServices`）。
- 脚手架默认产物（keywords、peerDep 区间、`aalis.service` 占位注释）：`packages/create-aalis-plugin/src/cli.ts`。
