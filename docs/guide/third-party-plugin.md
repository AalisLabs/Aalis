# 第三方插件开发者指南

> 目标读者：希望为 Aalis 编写并发布独立 npm 包的开发者。本文示范从零到发布的最短路径。

## 1. 包的形状

一个 Aalis 插件 = 一个 npm 包，**默认导出**一份 `definePlugin` 的产物：

```ts
import { definePlugin, logger } from '@aalis/core';

export default definePlugin({
  name: '@your-scope/plugin-hello',
  uses: { logger },
  apply({ logger }) {
    logger.use.info('hello from third-party plugin');
  },
});
```

加载器只认这份 default 定义。具名导出、函数 default、类 default 都会出声并跳过。

最小 `package.json`：

```json
{
  "name": "@your-scope/plugin-hello",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist"],
  "keywords": ["aalis-plugin"],
  "peerDependencies": {
    "@aalis/core": ">=0.17.0 <1.0.0"
  }
}
```

页面用自带前端（插件前端）时，静态网页放在包根的 `webui/` 下，`files` 写成 `["dist", "webui"]`：webui-server 只从包根的
`webui/` 托管它，没随包发布就找不到入口、页面不登记。写法见 [api-webui 的「插件前端」](../api/api-webui.md#插件前端)。

> `keywords` 里的 `"aalis-plugin"` 是**加载硬门**而非检索装饰：加载器只认它，漏写则插件
> 装上后永远不会被发现（启动日志会有「疑似插件缺关键词」提示，但不会加载）；`files` 须含
> 构建产物，否则入口解析失败同样不加载。入口与 `import()` 包名得到的是同一个文件：写了 `exports` 时取
> `"."` 按 import 条件（`node` / `import` / `default`，Node 启用 require(esm) 时另有 `module-sync`；`require` 不参与）
> 取到的目标，没写时取 `main`。
>
> `@aalis/core` 用 **peerDependency** 引用：core 在一个进程里只能装一份，写进 `dependencies` 时只要范围与宿主的
> core 不相容，包管理器就会给插件另装一份，插件随即在加载时被拒绝（见 [第 7 节](#two-cores)）。范围用 **`>=0.17.0 <1.0.0`**：
> 这是 `definePlugin` / 服务描述符首次成为公开面的版本。**1.0 之前 core 的公开面可能在次版本被删**，
> 用了更新的 API 就把下限再抬。别用 `^0.x` caret（只匹配单个次版本会把插件锁死）；也别用裸 `*`。

## 2. 声明 / 消费服务

### 2.1 仅消费（依赖现成服务）

描述符是**值导入**：写进 `uses`，并进入 `dependencies`（不是 `import type`）。

```ts
import { llm } from '@aalis/api-llm';
import { definePlugin, optional } from '@aalis/core';

export default definePlugin({
  name: '@your-scope/plugin-x',
  uses: { llm: optional(llm) },
  apply({ llm }) {
    llm.follow(model => {
      // 选得到即调；换人时先清理再挂新选中的那一家。attach 必须同步。
      // model.chat(...)
    });
  },
});
```

`llm` 是选择层，`llm.use` 是活的业务句柄，选择、缺席与固定同一家的规则见 [选择层与业务层](../core/context.md#选择层与业务层)；有状态资源用 [`follow`](../core/context.md#follow)。

### 2.2 自己 provide 一个服务

```ts
import { type LLMModel, llm } from '@aalis/api-llm';
import { definePlugin, lifecycle, provide } from '@aalis/core';

class MyModelHandle implements LLMModel { /* ... */ }

export default definePlugin({
  name: '@your-scope/plugin-my-llm',
  provides: [llm],
  uses: { provide, lifecycle },
  apply({ provide, lifecycle }) {
    provide.use(llm, new MyModelHandle(), {
      priority: 50,
      label: 'my-llm',
      entryId: `${lifecycle.use.id}/my-model`,
    });
  },
});
```

`provide.use(descriptor, instance, options?)` 的 `options`：`priority`、`exclusive`、`label`、`entryId`。
core 不做服务能力选择。服务选择只看「本插件偏好 > 全局偏好 > 优先级 > 注册顺序」，跨实例的「按能力挑选」交给领域 helper。

#### 能力挂在 handle 元数据上

以 LLM 为例：模型的能力（chat / tool_calling / vision …）作为 model handle 自身的 `capabilities` 暴露，由 `@aalis/api-llm` 的 helper 按需过滤：

```ts
import { LLMCapabilities, resolveLLMModel } from '@aalis/api-llm';
import type { LLMCapability } from '@aalis/api-llm';

class MyModelHandle {
  readonly capabilities: LLMCapability[] = [LLMCapabilities.Chat, LLMCapabilities.ToolCalling];
  // ...
}
provide.use(llm, new MyModelHandle(), { entryId: `${lifecycle.use.id}/my-model`, label: 'my-model' });

const model = resolveLLMModel(caps.llm, ref, [LLMCapabilities.Vision])?.use;
```

`resolveLLMModel` 的第一参是 `uses` 里的那一项选择层（只用它的 `list`），不是 Context；返回 `ProviderEntry<LLMModel>`，模型句柄在 `use` 上。

#### 推荐 `priority` 带

| 范围 | 用途 |
|-------|------|
| `0`（默认） | 普通真实提供者 |
| `10–50` | 希望盖过默认的次级提供者 |
| `200` | 系统级别；仅供 core 与系统级使用 |

上层跨 entry 调度请使用 `x.list()` / `x.of(id)` 或 `services.use.all(desc)`（只接收名字，**无** capabilities 参数）
与各 `*-api` helper（`resolveLLMModel` / `listLLMModels` / `resolvePlatformBySession` 等）。

`use` 默认打到本插件选中的那一家，挑选规则见 [选择层与业务层](../core/context.md#选择层与业务层)。偏好由用户在 WebUI 设置「系统」的服务偏好
或配置项 `servicePreferences` 里指定，插件不写偏好。

### 2.3 多提供者：per-entry 注册

需要在一个服务名下暴露多个实例时，在同一次 `apply` 里多次 `provide`，用 `entryId` 区分（格式按所用契约的约定，第一方契约都是激活 id 加 `/` 加子粒度）：

```ts
for (const model of models) {
  provide.use(llm, new MyModelHandle(model), {
    entryId: `${lifecycle.use.id}/${model.id}`,
    label: model.id,
  });
}
```

下游按条目 id 取其中一家（`caps.llm.of('<provider>/<model>')`），或调用各 `*-api` 中的 helper 跨实例路由。禁止再注册同名 facade entry。

## 3. 配置 schema

```ts
import { definePlugin, config, logger } from '@aalis/core';
import { defineConfig, parseConfig } from '@aalis/schema-config';

const configSchema = defineConfig({
  apiKey: { type: 'string', label: 'API Key', required: true, secret: true, onInvalid: 'error' },
  baseUrl: { type: 'string', label: 'API 地址', default: 'https://api.example.com', onInvalid: 'error' },
});

export default definePlugin({
  name: '@your-scope/plugin-x',
  configSchema,
  uses: { config, logger },
  apply({ config, logger }) {
    const cfg = parseConfig(configSchema, config.use, logger.use);
    // 使用 cfg.apiKey / cfg.baseUrl；发送请求前继续校验 URL 等业务约束
  },
});
```

> `secret: true` 表示字段的值是凭据，由 `@aalis/schema-config` 声明，不需要引入 `@aalis/api-webui`。
> 宿主把它的值存进密钥存储（Node 宿主是家目录的 `secrets.yaml`），配置文件里只留引用 `{ $secret: '<键>' }`，
> WebUI 不回显原值；插件经 `parseConfig` 读到的仍是原值。引用的键不在密钥存储里时 `parseConfig` 拒绝激活，
> 不回落默认值；这一行为在本批新版 schema-config 里，对它的依赖写成范围、下限抬到这个版本。值不是凭据、名字却像凭据的字段（如 `maxTokens`）可以写 `secret: false` 表明已判断过。
> 要把配置写回配置文件，用 `host-config` 的 `applyPluginConfig`，不要把 `parseConfig` 的结果或 `config.use`
> 原样交给 `setPluginConfig`：其中密钥字段是原值，宿主会拒收（见 [运行态与配置文档](../core/config.md#跨重启保留)）。
> 自定义字段类型（如 `'llm-ref'`）要 merging 到 `@aalis/schema-config` 的 `SchemaFieldTypes`，
> 值写该类型的取值类型（如 `'llm-ref': ModelRef`）。

WebUI 会自动根据 schema 渲染配置表单。

## 4. 生命周期

`provide.use()` 与 `events.use.on` 返回退订；经业务层登记方法的登记随激活撤回，**插件本身无需再退订这些**。需要做副作用清理（关闭 socket、清空 interval）时：

```ts
apply({ lifecycle }) {
  const timer = setInterval(work, 1000);
  lifecycle.use.onDispose(() => clearInterval(timer));
}
```

需要在对外登记仍在、声明的依赖仍可调用时交接数据，用 `lifecycle.use.onDrain`；`onDispose` 只释放自己的资源，那时依赖可能已不可用。插件用别的插件的服务时消费者 close 完提供者才 drain（边对声明服务的全部提供者建）；根激活用插件的服务时根 drain 先于插件 close。`App.stop()` 先冻结并进入停机态，再发 `app:stopping`（知会，不是清理通道），然后执行停机计划。单独 unload / disable / bounce 提供者时，正在用它的 required 消费者先收尾再关，收尾时提供者仍在。

## 5. 工具 / 命令 / WebUI 扩展点

| 想做的事 | 用什么 |
|----------|--------|
| 注册 AI 可调用的工具 | `uses: { tools }`，`tools.use.register(...)`（`@aalis/api-tools` 的描述符） |
| 注册斜杠命令 | `uses: { commands }`，`commands.use.command(...)`（`@aalis/api-commands`） |
| 自定义 WebUI 页面与提示 | `uses: { webui: optional(webuiServer) }`，`webui.use.definePage` / `notify`（`@aalis/api-webui`）。页面默认声明式，需要自绘时用插件前端；能放在哪见 [插件作者指南](../plugin-author-guide.md#ui-placement) |
| 注册 agent 输入预处理器 | `uses: { agent }`，`agent.use.registerPreprocessor(...)`（`@aalis/api-agent`） |
| 监听核心事件 | `uses: { events }`，`events.use.on('service:changed', …)` |

这些登记方法内部已处理「服务晚上线或换人时重挂」，登记不用先看 `present`。插件加载采用单遍式，无需关心依赖顺序；若还要在方法里 **读** hub（如 `tools.use.execute`），或希望激活闸清晰，把对应描述符写成 required（不要 `optional()`）；optional 依赖调读方法前先看 `present`。

## 5.1 类型从哪里 import；依赖怎么归类

`@aalis/core` 导出通用 IoC 类型与内置描述符（`definePlugin` / `ServiceSelection` / `events` / `logger` / …）。所有 **LLM / agent / 工具** 领域类型与描述符都在 `@aalis/api-*` 里；钩子与贡献点也不在 core，`hooks` / `contributions` 分别从 `@aalis/api-hooks` / `@aalis/api-contributions` 导入。

判定规则：**运行时值导入进 `dependencies`，纯类型导入进 `devDependencies`**。描述符是值——`import { tools } from '@aalis/api-tools'` 必须进 `dependencies`，不能只放 devDep。`@aalis/core` 恒为 peerDependency（区间 `>=x <1.0.0`，禁 caret），并同时列入 devDependencies 供本地编译；进程里只能有一份 core，插件解析到另一份即被拒载，见 [第 7 节](#two-cores)。`dependencies` 里的 `@aalis` 包版本同写 `>=当前版本 <1.0.0` 区间，不写 caret、精确版本或 `latest`：区间可被包管理器去重到与宿主同一份安装；caret 在 0.x 下只匹配同一个次版本，跨次版本就断，两个依赖各锁不同次版本时会装进两份同一契约包（两份 `declare module` 相撞成 TS2717，被 skipLibCheck 静默吞掉）；精确版本同样锁死；`latest` 发布出去等于不设上限。

`create-aalis-plugin` 生成的依赖已按这条规则写好，下限是生成时源上的最新版。

全部扩展点（事件 / 钩子 / 贡献点 / 配置字段 / 描述符）的归属表见
[docs/extensions/index.md](../extensions/index.md)。

## 6. 发布

```bash
npm publish --access public
```

发布前的清单（关键词、依赖归类、`aalis.service`）见 [插件作者指南「发布到插件市场」](../plugin-author-guide.md#发布到插件市场)。

用户在 WebUI 的插件市场里安装，装上立即加载；或在 Aalis 项目目录里安装：

```bash
npm install @your-scope/plugin-hello
```

终端里装的，重启实例或在 WebUI 插件区点「重新扫描」后加载（靠 `keywords` 含 `aalis-plugin` 被发现），**插件默认启用**。
`aalis.config.yaml` 的 `plugins` 段只放该包的**配置项**，不是启用开关：

```yaml
plugins:
  "@your-scope/plugin-hello":
    someOption: true
```

停用是把包名写进顶层 `disabledPlugins` 数组。

<a id="two-cores"></a>
## 7. 装了两份 @aalis/core

`@aalis/core` 在一个进程里只能有一份。npm 与 pnpm 都允许依赖树中存在同名包的多份安装；两份 core 同处一个进程时，日志中枢等进程级身份会静默分裂。因此 Aalis 在加载与注册两处核对 core 的身份，发现另一份即拒绝相关插件，其余插件照常加载。

### 报错

runtime 的插件加载器在 import 插件之前，按 node_modules 逐级上溯找出插件解析到的 `@aalis/core` 包目录（取真实路径），与宿主使用的那份比较；不同则拒绝加载该插件，记一条 error 级日志，写明两份的版本与路径：

```text
插件 "@your-scope/plugin-hello" 解析到另一份 @aalis/core（0.17.0：/path/to/my-plugin/node_modules/@aalis/core），宿主用的是 0.17.0：/path/to/aalis-project/node_modules/@aalis/core。@aalis/core 只能装一份：……
```

判据是包目录而不是版本号，两份版本相同同样会被拒绝。

加载器只核对插件包目录解析到的那一份。其余情形（插件依赖的契约包解析到另一份 core，或插件经自定义加载器载入、在代码中直接注册）由 core 自身拦截：每份 core 给自己创建的描述符与 `optional` 包装打上本副本的标记，`definePlugin`、插件注册与 `provide` 遇到另一份 core 创建的对象即报错：

```text
插件 "@your-scope/plugin-hello" 的 uses.logger 来自另一份 @aalis/core：进程里装了两份 core，只能装一份（……）
provide 的描述符来自另一份 @aalis/core：……
```

### 确认装了几份

在宿主项目目录（如 `/path/to/aalis-project`）执行：

- `npm query "#@aalis/core"`：列出每一份的 `location` 与 `version`，最直接。
- `npm explain @aalis/core`：逐份说明由哪个包带进来。
- `npm ls @aalis/core --all`：嵌套的那份会单独列出。存在多份时退出码仍为 0，只有版本不满足声明范围时才标 `invalid`。
- `pnpm why @aalis/core` / `pnpm ls @aalis/core --depth Infinity`：按版本而非路径计数，同一版本的两份不会分开显示；以 `link:` 接入的插件目录自带的 node_modules 也不在结果中。

最可靠的依据是 Aalis 启动日志中拒载的那条 error，它直接给出两份的路径与版本。

### 按来路修复

#### 本地插件目录装成了符号链接

`npm install ../my-plugin` 默认把插件目录装成符号链接。插件运行时从自身目录向上解析依赖，插件目录 devDependencies 里的那份 `@aalis/core` 就成了进程中的第二份。改用拷贝安装：

```bash
# npm
npm install --install-links ../my-plugin

# pnpm
pnpm add file:../my-plugin
```

npm 还须在宿主项目的 `.npmrc` 写 `install-links=true`，否则下一次普通 `npm install` 会把它改回符号链接。npm 的拷贝安装不随源码同步，插件改动并重新构建后需再次安装。也可以在插件目录执行 `npm pack`，再在宿主项目安装生成的 `.tgz`。不要用 `npm link`：不带 `--save` 时插件不进 `dependencies`，加载器发现不了；带 `--save` 仍是符号链接，同样装出两份。

#### 插件把 `@aalis/core` 写进了 `dependencies`

插件作者应把它移到 `peerDependencies`（`>=x <1.0.0`，禁 caret），并同时列入 `devDependencies` 供本地编译（见第 1 节）。修正版发布之前，用户可以在宿主项目根 `package.json` 用 `overrides` 把插件那份指向宿主的 core。npm 的覆盖值须与根 `dependencies` 中 `@aalis/core` 的范围字面完全相同：

```json
{
  "dependencies": { "@aalis/core": ">=0.17.0 <1.0.0" },
  "overrides": { "@aalis/core": ">=0.17.0 <1.0.0" }
}
```

pnpm 可以直接引用根依赖的范围：

```json
{
  "pnpm": { "overrides": { "@aalis/core": "$@aalis/core" } }
}
```

`overrides` 只是临时办法，代价是插件运行在它未声明兼容的 core 版本上；插件发布修正版后应移除。

#### 插件的 peer 范围不含宿主的 core 版本

插件在根依赖里、其 peer 范围不含宿主的 core 版本时（例如用了 `^0.x` caret，或 core 升级后旧插件的范围不再覆盖新版本），npm 不会装出第二份：普通安装报 ERESOLVE；显式执行 `npm install @aalis/core@<新版本>` 只告警并保留一份，`npm ls` 把它标为 `invalid`，插件运行在它未声明兼容的 core 上。只有由其它包间接带进来、自身对 core 用了窄 peer 范围的包，npm 才会在它下面嵌套一份满足其范围的 core。插件作者应把范围改为 `>=x <1.0.0`；用户侧可升级插件，或同样用上面的字面值 `overrides` 临时处理。

#### 安装时用了 `--legacy-peer-deps` 或 `--force`

这两个选项不会装出两份 core，但会让 peer 版本不符静默通过。去掉它们重新安装，按 ERESOLVE 提示升级 core 或插件。

#### 范围相容却仍有多份

各方声明的范围本来相容、依赖树里却仍留有多份时，执行 `npm dedupe` 或 `pnpm dedupe`。

## 8. 参考实现

| 类型 | 参考包 |
|------|--------|
| 单一服务提供者 | `plugin-llm-openai`, `plugin-llm-deepseek`, `plugin-tools` |
| 多 entry 注册 | `plugin-llm-ollama`、`plugin-llm-openai`（每 model） |
| 跨 entry helper | `api-llm` (`resolveLLMModel`)、`api-platform` (`resolvePlatformBySession`) |
| 工具注入 | `plugin-todo-list`, `plugin-tool-search` |
| 命令注入 | `plugin-commands` |
| WebUI 页面与提示 | `plugin-scheduler`（新建与编辑是带输入的动作）、`plugin-paper`（标签页、详情与会话面板）、`plugin-doctor`（运行后发出或撤回提示） |
| `follow` | `plugin-tool-onebot`（`sessionHistory.follow` 重挂访问规则） |

## 9. 进一步阅读

- [脚手架上手指南](./scaffolding.md)：用 `create-aalis-plugin` 生成本文所述的包结构
- [插件作者指南「发布到插件市场」](../plugin-author-guide.md#发布到插件市场)：发布前的清单
- [插件作者指南「报错与故障说明」](../plugin-author-guide.md#_9-5-报错与故障说明)：用户看得到的报错怎么写
- [架构总览](../architecture.md)
- [api 包设计](../design/api-packages.md)
- [枢纽服务：第三方能力的登记契约](../design/hub-services.md)
- [从 0.17 迁移对照](../plugin-author-guide.md#从-0-17-迁移)
- [从 0.16 迁移对照](../plugin-author-guide.md#从-0-16-迁移)
