# @aalis/api-plugin-source

插件来源契约：宿主的热扫描服务描述符与插件包入口约定。不含服务实现。

## 角色

- `pluginSource`：服务描述符。能在运行中重新发现插件的宿主（`@aalis/runtime` 扫描 node_modules 或 packages 目录）在根上提供它；打包进来的静态插件表没有可重扫的来源，不提供。消费方以 `optional(pluginSource)` 声明，市场装完新包、WebUI 的扫描接口经它让宿主重新发现插件。
- `pluginDefinitionOf(mod)`：插件包的入口约定——模块的 default 须是 `definePlugin` 的产物。加载器与包管理共用这一份判定。

## 安装

```bash
pnpm add @aalis/api-plugin-source
```

## 使用

```ts
import { optional } from '@aalis/core';
import { pluginSource } from '@aalis/api-plugin-source';

// uses: { source: optional(pluginSource) }
const names = (await source.current?.rescan()) ?? [];
```

`rescan()` 返回本次新登记的主实例名，不等激活静置；判断某个插件是否就位看 plugins 服务的注册表。
