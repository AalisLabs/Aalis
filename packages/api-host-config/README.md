# @aalis/api-host-config

宿主配置文档契约：`host-config` 服务描述符、`HostConfig` 读写面与配置文档类型 `AalisConfig`。不含服务实现。

## 角色

- `hostConfig`：服务描述符。Node 宿主 `@aalis/runtime` 把配置文档（`aalis.config.yaml`）以它独占登记在根上；别的宿主要让插件读写文档，自己提供。管理类插件（WebUI、市场、CLI、authority）在 `uses` 里声明它。
- `HostConfig`：文档读写面加 `save()`。读写的是文档形态：schema 里 `secret: true` 的字段在文档里是引用 `{ $secret: '<键>' }`，值在宿主的密钥存储里，插件读原值用自己的 `config`。
  - 读法（`get`、`getAll`、`getPluginConfig`、`getServicePreferences`）返回复制品，写方法存的也是入参的复制品：之后改这些对象都不影响文档，要改经写方法写回。
  - 改插件配置用 `applyPluginConfig(instanceId, submitted)`：拆出密钥、更新运行态、写文档并落盘一步完成，返回 `{ status: 'refused' }` 或 `{ status: 'applied', reloaded, saveError? }`。
  - `setPluginConfig` 只写文档，密钥字段上的非空明文抛错（宿主查得到 schema 时）。
  - 其余写方法只改文档；启停、服务偏好等管理动作只改运行态，要跨重启保留，调用方两边都写。
- `ownHostConfig`：只读窄面，与 `hostConfig` 同一个服务名、描述符对象不同。`get()` 返回本实例在文档里那一段的复制品（没有这一段时为空对象），没有写方法。按会话读带标记字段（configSchema 顶层写了 `session` 的字段）的插件在 `uses` 里声明它，不声明整份 `hostConfig`。它只供消费，不能拿去 provide。
- `'host-config:changed'` 事件：宿主配置文档在内存里确实被改了时由宿主发，参数是 `HostConfigChange`（只改了一个实例的配置段时为 `{ instanceId }`，其余为 `{ document: true }`）。写入相同的值、启停、配置文件解析失败都不发；不表示已落盘，也不保证恰好一次。
- `AalisConfig`：配置文档类型，也是各域业务字段做 declaration merging 的目标。
- `ConfigSaveRefusedError` / `isConfigSaveRefused(err)`：配置源有尚未生效的外部修改、宿主为免覆盖而拒写时 `save()` 的拒绝原因，以及用来把它与写入失败区分的判据。判据按错误的 `name` 判定，进程里装有两份本包时也认得。
- `saveFailureText(err, reconcile)`：落盘失败的那一句（文字对象）。拒写说已在运行态生效、未写入配置文件，并按 `reconcile`（`'reload'` 或 `'restart'`）说之后怎样与文件对齐；其余失败说写入失败、改动保留在文档里。

## 安装

```bash
pnpm add @aalis/api-host-config
```

## 使用

```ts
import { optional } from '@aalis/core';
import { hostConfig } from '@aalis/api-host-config';

// uses: { plugins: pluginsService, doc: optional(hostConfig) }
if ((await plugins.use.disable(id)) && doc.present) {
  doc.use.setPluginEnabled(id, false);
  await doc.use.save();
}
```

扩展文档字段：

```ts
declare module '@aalis/api-host-config' {
  interface AalisConfig {
    myFeature?: { enabled: boolean };
  }
}
```
