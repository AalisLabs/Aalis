# @aalis/api-package-manager

包管理契约：`package-manager` 服务描述符与装卸、更新接口 `PackageManagerService`（`UpdateTarget` / `UpdateResult`）。不含服务实现，默认提供者是 `@aalis/plugin-package-manager`。

## 角色

- `packageManager`：服务描述符（服务名 `package-manager`）。WebUI 市场以 `optional(packageManager)` 声明，缺席时装、卸、更新三条路由返回 503。
- `PackageManagerService`：`install` / `uninstall` / `serviceDependents` / `registry` / `update`。装卸落在项目根 `dependencies`；类型、撤销通道、来源与服务依赖者这几道闸都在服务层。`registry` 返回安装实际使用的 npm 源，WebUI 市场按它查最新版与可更新。`update` 必须整批提交，成功后重启进程。

## 安装

```bash
pnpm add @aalis/api-package-manager
```

## 使用

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

## 许可

见仓库根目录 LICENSE。
