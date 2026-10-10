# api-package-manager — 包管理契约

**包名**: `@aalis/api-package-manager`  
**源码**: `packages/api-package-manager/src/index.ts`  
**实现**: `@aalis/plugin-package-manager`

## 概述

本包定义 `packageManager` 描述符（服务名 `package-manager`）、服务接口 `PackageManagerService`、安装的结果 `InstallResult`、卸载的选项 `UninstallOptions` 与更新用的 `UpdateTarget` / `UpdateResult`，不含实现。装卸都落在宿主安装集（`host-paths` 的 `app`）`package.json` 的 `dependencies`：Node 宿主的 npm 加载器只从那里发现插件。

## 服务接口

```ts
interface PackageManagerService {
  install(npmPkg: string): Promise<InstallResult>;
  uninstall(pluginName: string, options?: UninstallOptions): Promise<{ ok: boolean; message: string }>;
  serviceDependents(name: string): string[];
  registry(): Promise<string>;
  update(targets: UpdateTarget[]): Promise<UpdateResult>;
}

interface InstallResult {
  ok: boolean;
  message: string;
  plugin?: string;
}

interface UninstallOptions {
  removeConfig?: boolean;
}

interface UpdateTarget {
  name: string;
  version: string;
}

interface UpdateResult {
  ok: boolean;
  message: string;
  conflicts?: string[];
  restarting?: boolean;
}
```

- `install`：装进根 `dependencies` 与 node_modules，随后经宿主的 `plugin-source` 热扫描让加载器发现它。只接受插件（`aalis-plugin`）与前端界面（`aalis-interface`）包。装后等插件状态机静置（`plugins.idle()`）再读主实例状态：激活失败、转为 `error` 态（如缺配置）时仍返回 `ok: true`，`message` 说明激活失败及原因；慢激活转入后台仍在进行（`idle` 不等它）、或在等 required 依赖时同样返回 `ok: true`，`message` 说明尚未激活。装上的插件已登记时 `plugin` 是它的主实例 id，即加载器解析出的定义名（可能与包名不同），界面据它打开这个插件；前端界面这类不进插件列表的包与没装成的不给。
- `uninstall`：从根 `dependencies` 摘掉并执行 npm uninstall，卸掉它的全部实例并清掉它们的停用标记（否则重装时带着上次的停用态登记）。类型、撤销通道、来源与服务依赖者几道闸都在服务层，被拒时返回 `{ ok: false, message }`。配置段与它们引用的密钥默认留着，重装后照原配置启动，与在终端里 `npm uninstall` 一致；`options.removeConfig` 为 `true` 时一并删掉各实例的配置段，落盘后只有这些段引用的密钥随之删除（`host-config` 的 `removePluginConfig`）。配置文档没有要改的就不写配置文件；写了却没写成时包已卸掉，仍返回 `ok: true`，`message` 写明原因与要手动删的残留。
- npm 本身失败（连不上源、源上没有、权限、磁盘、平台不支持、peer 冲突、浏览器下载、原生模块编译）时，三个操作的 `message` 只写认出的原因与修法，npm 的整段输出记进日志；认不出的写 npm 的最后一条报错，并指向安装排障页。`update` 的预检遇到不是 peer 冲突的失败时同样写原因（「依赖预检没跑成：…」），不报成冲突。
- `serviceDependents(name)`：卸载 `name` 会打断的插件——`name` 的某个实例正在提供的某个服务没有别的插件正在提供（「正在提供」指已激活或激活中；已禁用、激活失败或等待依赖的提供者不算），而这些插件 required 该服务（已禁用的不算）。`name` 的实例只是在等别的插件启动时（pending，按 [缺与在等的共享判据](../services/doctor.md#缺与在等的共享判据-unmetdependencies) 不缺什么）马上就会提供，照样算在提供；它的实例都没在提供时（如待配置、激活失败、停用，或 pending 而缺服务）卸掉它断不了谁，为空：依赖方本来就缺这个服务，换一个提供者时可以先卸后装。`name` 是插件定义名；市场的卸载前预警按 npm 包名近似查询，定义名与包名不同的插件预警为空，卸载闸按解析出的定义名查，不受影响。卸载闸与市场的卸载前预警共用这一份判定。
- `registry()`：安装与更新实际使用的 npm 源，即在安装集目录执行 `npm config get registry` 的结果（去掉尾部斜杠），首次成功后缓存；查询失败时拒绝且不缓存，下次调用重查。市场的最新版与「可更新」按它查，才与真正装到的版本一致。作用域源（`@scope:registry`）不在此列。
- `update(targets)`：整批更新到指定版本，成功后重启进程。必须整批提交：peer 冲突只有对整张版本映射一次预检才能发现，逐个更新还会重启多次、中间态半新半旧。`ok` 且 `restarting` 时进程即将退出，调用方要在退出前发出响应；预检失败时 `conflicts` 列出逐条冲突。

## 获取方式

```ts
import { packageManager } from '@aalis/api-package-manager';
import { definePlugin, optional } from '@aalis/core';

export default definePlugin({
  name: '@acme/plugin-example-market',
  uses: { packageManager: optional(packageManager) },
  apply({ packageManager }) {
    // 在处理指令或请求时调用，不要在 apply 里直接装包（每次激活都会装一次并触发重扫）；服务缺席时 present 为 false
    async function install(npmPkg: string): Promise<string> {
      if (!packageManager.present) return '包管理服务不可用';
      return (await packageManager.use.install(npmPkg)).message;
    }
    // 把 install 挂到指令或路由的处理函数上
  },
});
```

## 消费方

| 插件 | 用途 | 服务缺席时 |
|---|---|---|
| [plugin-webui-server](../plugins/plugin-webui-server.md) | 市场的安装、卸载、更新路由与卸载前预警；按 `registry()` 查最新版与可更新 | 三条路由返回 503，依赖图的 `serviceDependents` 为空，市场列表仍可浏览（最新版退回检索源查） |

## 实现者

- `@aalis/plugin-package-manager`（源码 `packages/plugin-package-manager/src/index.ts`）
