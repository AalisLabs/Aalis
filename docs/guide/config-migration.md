# schema-config 0.14 配置迁移

插件配置由 schema 统一解析。缺省使用默认值，普通字段的无效值告警后回落；地址、启动参数等声明了 `onInvalid: 'error'` 的字段拒绝无效值。解析不会改写配置文件。

## 作用域配置

flow-control、trigger-policy、trigger-laya 的 `scopes: null`（包括 YAML 裸键）在旧解析中表示空范围，即这三个插件不对任何会话生效；新解析中表示使用默认范围 `['*:group']`，群聊会开始受它们约束。要保持原行为，升级前将它改成 `scopes: []`。显式 overrides 仍按各插件的覆盖规则生效。

`scopes` 的逗号分隔字符串改为数组。checkpoint 的旧字符串还支持空白分隔，按同一含义转成数组；它的 null 本来就取默认值，无需改写。未转换的旧字符串会告警并回落默认值，checkpoint 回落为 `['webui:*']`，原先覆盖的 OneBot 会话就不再记快照。

运行时不拦截这些旧写法，`null` 也不告警。检查须在升级后第一次经 WebUI 保存这些插件之前完成：WebUI 会把 `null` 按默认值显示并保存，之后工具就查不出原写法；旧字符串在 WebUI 中显示为未选任何范围，与实际生效的默认范围不一致。

```yaml
plugins:
  '@aalis/plugin-flow-control':
    scopes: []
  '@aalis/plugin-trigger-policy':
    scopes: ['onebot:group', 'cli:*']
```

仓库提供一次性离线工具，需在此版本的源码目录安装开发依赖后运行。先停止使用该配置文件的实例，再执行检查；不要在运行期间与配置热重载同时写文件。

```sh
pnpm exec tsx tools/migrate-config-0.14.ts --check /path/to/aalis.config.yaml
pnpm exec tsx tools/migrate-config-0.14.ts --write /path/to/aalis.config.yaml
```

工具处理上述插件及其命名实例的作用域字段，以及 trigger-policy / trigger-laya 旧名单数组（`triggerNames` / `muteKeywords`，含 policy 覆盖项）。名单仅在能无损转成逗号文本时转换；含分隔符、成员注释或共享 YAML 锚点时须人工处理。工具不连接服务，不输出配置值。检查模式不写文件：退出码 0 表示无需转换，1 表示有可转换项，2 表示需要人工处理或文件错误。写入模式先创建 `.before-schema-0.14` 备份，已有同名备份时拒绝覆盖；有需人工处理的项时整份文件不写入。备份与目标通过同目录临时文件完整写好后发布，目标须是普通文件；请以配置文件属主身份运行。运行后核对差异再启动。备份与差异输出都含配置原文（包括密钥），只在本人终端查看。首次启动时如需补全默认值或裁掉未声明字段，runtime 会整份重写配置，注释不保留；备份留到启动验证后再移走。

## 平台模板与 MCP 暴露范围

`plugin-session-manager.platformProfiles[].think` 的旧 `true` / `false` 由工具等价转换为 `on` / `off`；原有字符串不变。

`plugin-mcp-server.toolGroups: null` 旧版会拒绝启动，新解析把 null 视为缺省，等价 `[]`（暴露全部工具组）。工具将此项标为需人工处理：明确填写允许暴露的组，或先禁用该插件；不要未经核对便改成空数组。

## 开关的空值

tool-onebot 各工具组的 `enabled` 写成空值（裸键、`~`、`null`）、`0` 或 `''` 时，旧版等同关闭，新解析取默认值 `true`（`0` 与 `''` 另有告警）。要关闭请明确写 `false`。离线工具不检查这一项。

## 地址与 MCP 参数

缺省地址可取 schema 默认值；显式错误地址会使对应插件进入 error，改正后可重新激活。不要依靠错误值回落到另一个地址。

MCP 的 args 必须为参数数组，env 必须为键值映射；其中有无效成员时该 server 不启动，其他合法 server 照常连接。旧多行文本需手动按参数边界改写，工具不会猜测或拆分。合法空字符串参数会原样传给子进程。

`__proto__`、`constructor`、`prototype` 是整个配置系统的保留键，不可用作 env 名称。现有宿主与 Core 的配置拷贝会先移除这些键，插件严格解析不能恢复或诊断已被宿主移除的内容；这项既有拷贝规则没有在本轮变更。

## 自定义插件

使用 `defineConfig`、`ConfigOf` 与 `parseConfig` 的包，运行时及公开声明文件都依赖新版 `@aalis/schema-config`，依赖下限须为 0.14.0。字段类型扩展 `SchemaFieldTypes` 的值改为实际取值类型，例如 `'llm-ref': ModelRef`。配置读取示例见 [第三方插件开发](third-party-plugin.md)。
