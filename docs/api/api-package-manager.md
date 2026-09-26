# api-package-manager — 包管理契约

**包名**: `@aalis/api-package-manager`  
**源码**: `packages/api-package-manager/src/index.ts`  
**实现**: `@aalis/plugin-package-manager`

## 概述

本包定义 `packageManager` 描述符（服务名 `package-manager`）、服务接口 `PackageManagerService` 与更新用的 `UpdateTarget` / `UpdateResult`，不含实现。装卸都落在项目根 `dependencies`：Node 宿主的 npm 加载器只从那里发现插件。

## 服务接口

```ts
interface PackageManagerService {
  install(npmPkg: string): Promise<{ ok: boolean; message: string }>;
  uninstall(pluginName: string): Promise<{ ok: boolean; message: string }>;
  serviceDependents(name: string): string[];
  update(targets: UpdateTarget[]): Promise<UpdateResult>;
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

- `install`：装进根 `dependencies` 与 node_modules，随后经宿主的 `plugin-source` 热扫描让加载器发现它。只接受插件（`aalis-plugin`）与前端界面（`aalis-interface`）包。
- `uninstall`：从根 `dependencies` 摘掉并执行 npm uninstall。类型、撤销通道、来源与服务依赖者几道闸都在服务层，被拒时返回 `{ ok: false, message }`。
- `serviceDependents(name)`：卸载 `name` 会打断的插件——`name` 提供的某个服务没有别的插件正在提供（已激活或激活中；已禁用、激活失败或等待依赖的同类提供者不算），而这些插件 required 该服务（已禁用的不算）。`name` 是插件定义名；市场的卸载前预警按 npm 包名近似查询，定义名与包名不同的插件预警为空，卸载闸按解析出的定义名查，不受影响。卸载闸与市场的卸载前预警共用这一份判定。
- `update(targets)`：整批更新到指定版本，成功后重启进程。必须整批提交：peer 冲突只有对整张版本映射一次预检才能发现，逐个更新还会重启多次、中间态半新半旧。`ok` 且 `restarting` 时进程即将退出，调用方要在退出前发出响应；预检失败时 `conflicts` 列出逐条冲突。

## 获取方式

```ts
import { packageManager } from '@aalis/api-package-manager';
import { definePlugin, optional } from '@aalis/core';

export default definePlugin({
  name: '@acme/plugin-example-market',
  uses: { packageManager: optional(packageManager) },
  apply({ packageManager }) {
    // 在处理指令或请求时现取，不要在 apply 里直接装包（每次激活都会装一次并触发重扫）；服务缺席时 current 为 undefined
    async function install(npmPkg: string): Promise<string> {
      const pm = packageManager.current;
      if (!pm) return '包管理服务不可用';
      return (await pm.install(npmPkg)).message;
    }
    // 把 install 挂到指令或路由的处理函数上
  },
});
```

## 消费方

| 插件 | 用途 | 服务缺席时 |
|---|---|---|
| [plugin-webui-server](../plugins/plugin-webui-server.md) | 市场的安装、卸载、更新路由与卸载前预警 | 三条路由返回 503，依赖图的 `serviceDependents` 为空，市场列表仍可浏览 |

## 实现者

- `@aalis/plugin-package-manager`（源码 `packages/plugin-package-manager/src/index.ts`）
