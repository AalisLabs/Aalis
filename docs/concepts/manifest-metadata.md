# 插件清单元数据：两套独立元数据源（manifest metadata）

**适用对象**：编写或维护 Aalis 插件的第三方作者。

## 概述：为什么插件作者要关心它

一个 Aalis 插件会把元数据写在两个互不相通的地方。它们由不同的代码、在不同的时间读取，用途也不同。

| 源 | 写在哪 | 谁读 | 何时读 | 干什么 |
|---|---|---|---|---|
| **A. 运行时定义** | `export default definePlugin({ provides, uses, … })` | **core**（`PluginManager`） | 插件**已安装并加载进进程后** | 拓扑排序、激活门控、provides 校验 |
| **B. 安装前披露源** | `package.json` 的 `aalis.service.{provides,required,optional}` | **webui-server 的市场路由** | 插件**还在 npm 上、尚未安装时** | 给用户看「装它会引入/需要哪些服务」 |

关键事实是：**core 永远不读 `package.json`，市场永远不读运行时定义。** 作为作者，你需要把两边写成一致。本仓库用 `test/architecture/manifest-parity.test.ts` 守第一方插件：对账源是 default 导出的定义对象——`provides` 取描述符 `.name`；`uses` 经 core 的 `requiredNames` / `optionalNames` 展开（`optional()` 包装与内置能力排除走同一套归一化）。

除了这两套服务元数据，`package.json` 上还有几个纯关键词或标记门：`keywords` 里的类型词（如 `aalis-plugin`）决定一个包能不能被当插件加载、在市场归到哪一类；`aalis.client` 决定它能不能被当前端发现。

> 运行时 DI 的**语义**（`uses` 里 required 与 optional 如何选、`provides` 的校验、`follow`）已在 `docs/plugin-author-guide.md` 第 2–3.5 节详述，本文不重复。

---

## 源 A：运行时定义（core 读）

### 加载器只认 default 定义

两加载器共用 `pluginDefinitionOf`：入口的 **default 导出**须是 `definePlugin` 的产物（带非空 `name` 与函数 `apply` 的对象）。具名导出、函数 default、类 default、普通对象都会 warn 并跳过——「装了没反应」必须出声。default 为函数或类不算：它们天然继承 `Function.prototype.apply`，只查 `.apply` 会把函数误当插件。

`App.autoLoadPlugins` 在拿到定义后再注册。定义 `name` 与包名不一致会 warn：配置键 / 热扫描 / 卸载均以定义的 `name` 为准。

典型入口（以 `@aalis/plugin-tools` 为准）：

```ts
import { tools } from '@aalis/api-tools';
import { definePlugin, logger, provide } from '@aalis/core';

export default definePlugin({
  name: '@aalis/plugin-tools',
  displayName: '工具注册表',
  subsystem: 'agent',
  provides: [tools],
  uses: { logger, provide },
  apply({ logger, provide }) {
    provide(tools, new ToolRegistry(logger));
  },
});
```

`configSchema` 由 `@aalis/schema-config` 经 declaration merging 挂到 `PluginMeta` 上，是配置的唯一声明来源。`extends` 由 `@aalis/api-webui` 挂到 `PluginMeta`，写在 `definePlugin({ extends: { events, hooks } })` 里，供前端展示；webui-server 读 `entry.definition.extends`。

### `uses`：激活闸 + 关停边

未包 `optional()` 的外部服务参与激活闸：必须都已注册才会激活，且建成关停依赖边。包了 `optional()` 的不参与激活闸，缺席不拦激活，到场后绑定接口仍可用（`current` 可能为 `undefined`）。内置能力绑的是激活自身，不成边、不进闸。

### `provides`：激活后校验

`provides` 是描述符数组。`apply` 跑完后，core 按本次激活的 instanceId 检查每个名字是否确已提供。缺一个就把插件打成 `error`。

`provide(..., { onBehalfOf })` 代登记的条目归属被代者身份，**不计入**代理人：若把代登记的服务写进本清单，会以「声明 provides 但未实际注册」进入 error。

dev 模式下，实际 `provide` 了但没有在 `provides` 里声明的服务名会 warn（下游依赖排序将无法找到该 provider）。

---

## 源 B：`package.json` 的 `aalis.service`（市场读）

这块纯粹给安装前披露使用，core 完全不感知。市场路由从 npm registry 的 packument 读取 latest 版本的 `aalis.service` 和依赖名。

`PluginManifest.service` 的形状：

```ts
service?: { required?: string[]; optional?: string[]; provides?: string[] };
```

写法（以 `@aalis/plugin-scheduler` 的形态为准：字符串服务名，与描述符 `.name` 对齐）：

```jsonc
{
  "name": "@aalis/plugin-scheduler",
  "keywords": ["aalis", "aalis-plugin"],
  "aalis": {
    "service": {
      "required": ["tools", "cron-engine"],
      "optional": ["storage", "webui-server"],
      "provides": ["scheduler"]
    }
  }
}
```

用户在 WebUI 市场点开一个还没安装的包时，前端展示「装它会新增哪些服务、需要哪些、可选用哪些」。安装之前 core 拿不到运行时定义，只能靠这份静态声明。

> `aalis.service` 与「安装后」披露不是一回事。插件安装好之后的能力披露走 `/api/plugins`，读的是 core 状态里的运行时 `provides` / `required` / `optional`（`PluginStatusEntry` 上为服务名数组）。源 A 一旦漂移，会让「安装前 / 安装后」的披露不一致。

`create-aalis-plugin` 在勾选了扩展点时会写出对应的 `aalis.service.optional`（与生成的 `uses: { tools: optional(tools), … }` 对齐）；未勾选时不带 `aalis` 字段。一旦你增加 `provides` 或改 `uses`，要同步 `package.json`。

---

## 两套源必须一致

| 源 A（`definePlugin`） | 源 B（`package.json`） |
|---|---|
| `provides: [scheduler]`（描述符 `.name === 'scheduler'`） | `aalis.service.provides = ["scheduler"]` |
| `uses` 里未包 `optional()` 的外部服务 | `aalis.service.required` |
| `uses` 里 `optional()` 包装的外部服务 | `aalis.service.optional` |
| 内置能力（`logger` / `events` / `config` / `lifecycle` / `provide` / `services` / `hooks` / `contributions`） | **不写**进 `aalis.service` |
| `hostConfig` / `app` / `plugins`（普通宿主服务） | 按实际 `uses` 是否 optional 写入 required/optional |

第一方对账：`test/architecture/manifest-parity.test.ts` 对每个 `keywords` 含 `aalis-plugin` 的包 `import()` 源码入口，要求 default 是插件定义，并逐项比较上述三组名字。比对走编译后的导出（或源码入口的 default），不要用正则扫源码——嵌套数组（如工具参数 `required: ['urls']`）会假阳性。

第三方仓库没有这条测试时，应用同一规则自己做 CI。

---

## 类型/标记门：`keywords` 与 `aalis.client`

### `keywords` 类型词：加载门 + 市场分类

唯一判定「这是不是可加载插件」的依据，是 `keywords` 含 `'aalis-plugin'`：

```ts
export function isLoadablePlugin(meta: Record<string, unknown>): boolean {
  const keywords = Array.isArray(meta.keywords) ? (meta.keywords as string[]) : [];
  return keywords.includes('aalis-plugin');
}
```

两个加载器共用这一个纯函数。每类包打各自的类型词，互斥：

| 包类型 | 类型关键词 | 会被当插件加载？ | 市场归类 |
|---|---|---|---|
| 功能插件 | `aalis-plugin` | 是 | `plugin` |
| 契约/SDK（`*-api`） | `aalis-api` | 否 | `api` |
| 纯数据 schema（`schema-*`） | `aalis-schema` | 否 | `schema` |
| 前端界面 | `aalis-interface` | 否 | `interface` |
| 工具库（`util-*`） | `aalis-util` | 否 | `util` |
| 核心 / 工具链 | `aalis-core` / `aalis-runtime` | 否 | （不进市场检索五类） |

市场按类型词分类（`classifyPackage`），五类各发一条 npm 检索再合并。功能插件必须有 `keywords: ["aalis-plugin"]`，否则两个加载器都不会发现它——这是比 `aalis.service` 更硬的门。脚手架默认就带上了它。

漏写关键词且 peer/dependencies 含 `@aalis/core`、又没有任何 `aalis-*` 类型词时，加载器会 warn「疑似插件缺关键词」。

### `aalis.client: true`：前端发现门（会被读取）

前端包用 `aalis.client: true` 标记自己是一个 WebUI 前端候选。收录条件是 `aalis.client === true` **且** `dist/index.html` 存在。`@aalis/plugin-webui-client` 同时标了 `aalis.client: true` 和 `keywords: ["aalis-interface"]`。纯静态前端包不会被 runtime 当插件加载。

插件也可以在 `apply` 里 `provide(webuiClient, impl)` 主动覆盖自动发现。

### `aalis.util: true`：未被读取的装饰性字段

工具库包的 `package.json` 里可能有 `aalis: { util: true }`，但没有任何代码读取 `aalis.util`。市场把一个包归为 `util` 类，靠的是 `keywords` 含 `'aalis-util'`。不要把任何行为挂在 `aalis.util` 上。

---

## 注意事项与边界情形

1. **两套源不自动对账。** core 不读 `package.json`，市场不读运行时定义——必须手写一致；第一方靠 `manifest-parity` 测试兜底。
2. **`provides` 必须等于本次激活实际登记的服务名。** 少声明会导致 dev warn、或拓扑排不到你；多声明（含误把 `onBehalfOf` 代登记算进自己）会在激活后校验失败。
3. **市场读的是 npm packument 的 latest 版本**，不是你本地工作区——`aalis.service` 改了之后要发版才会在市场生效。
4. **`keywords: ["aalis-plugin"]` 是加载硬门。** 漏了它，插件永远不被发现。
5. **`aalis.client` 被读取、`aalis.util` 不被读取。** 前者控制前端发现，后者是装饰性字段。
6. **`extends` 写在 `definePlugin` 对象上**（`PluginMeta` 字段），不要另导出带下划线的具名绑定；消费端读 `definition.extends`。

---

## 交叉链接

- 运行时 DI **语义**：`docs/plugin-author-guide.md` 第 2–3.5 节。
- 服务模型：`docs/concepts/service-model.md`。
- 存储 URI 文法（per-root `entryId`）：`docs/concepts/storage-uri-grammar.md`。
- 安装后能力披露：`docs/services/webui.md`。
- 脚手架默认产物：`docs/guide/scaffolding.md`。
