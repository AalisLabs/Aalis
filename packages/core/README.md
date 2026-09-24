# @aalis/core

Aalis 的插件运行底座：显式服务声明、按激活绑定、资源清理与依赖编排。Core 环境无关，不包含业务服务或文件系统实现。

## 角色

插件通过 `definePlugin({ uses, apply })` 声明使用的服务。事件、钩子、贡献点、配置、日志、生命周期、发布与查询入口，和第三方服务共用容器与描述符协议；没有默认注入。

提供者登记进容器的是实现对象本身，描述符的 `bind` 为每个消费者激活造调用接口。资源随消费者清理，服务替换通过 `ServiceRef.follow` 交接；关闭根据资源归属与服务依赖分阶段执行。

## 安装

```bash
pnpm add @aalis/core
```

## 使用

```typescript
import { definePlugin, events, logger } from '@aalis/core';

export default definePlugin({
  name: '@scope/plugin-example',
  uses: { events, logger },
  apply({ events, logger }) {
    events.on('app:started', () => logger.info('ready'));
  },
});
```

监听登记属于这次激活，卸载时自动撤回。参见 [插件定义与生命周期](../../docs/core/context.md)、[服务](../../docs/core/service.md) 和 [第三方插件指南](../../docs/guide/third-party-plugin.md)。

## 许可

见仓库根目录 LICENSE。
