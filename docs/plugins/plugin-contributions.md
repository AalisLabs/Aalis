# plugin-contributions — 贡献点登记表

**包名**: `@aalis/plugin-contributions`  
**源码**: `packages/plugin-contributions/src/index.ts`

## 概述

`contributions` 服务的默认提供者，契约见 [api-contributions](../api/api-contributions.md)。core 不内置贡献点；agent、adapter-onebot、memory-history、memory-summary、memory-vector、skills、user-profile 等插件都 required `contributions`，部署时须装上本插件。

## 插件声明

```ts
export default definePlugin({
  name: '@aalis/plugin-contributions',
  displayName: '贡献点',
  subsystem: 'core',
  provides: [contributions],
  uses: { provide },
  apply({ provide }) { /* 见源码 */ },
});
```

无配置项。

## 行为

- **全局键**：登记以 `<激活 id>/<spec.id>` 为全局键，同键为替换；旧登记的退订按条目身份失效，同键已被替换时不做任何事。
- **id 校验**：与绑定门面共用 `assertContributionId`，`spec.id` 为空或含 `/` 时抛 `TypeError`。
- **枚举**：`collect` 按全局键码元序（默认比较，不依赖 locale）给出快照，spec 按引用给出，不拷贝、不改写。
- **无执行**：登记表只做同步的数据插入与快照枚举，永不执行插件代码；如何调用 spec 由贡献点的收集方决定。
- **归属**：登记的归属与撤回由绑定门面的账本负责，激活关闭时与事件、服务登记同一拍撤回；本插件只按条目身份删除。

## 部署

- `npm create aalis` 的 minimal / standard / full 档已包含本插件与 [plugin-hooks](./plugin-hooks.md)；bare 档不带任何插件，需自行安装。
- 已有项目需执行 `npm i @aalis/plugin-hooks @aalis/plugin-contributions`。npm 加载器只发现项目 `package.json` 的直接依赖，市场的「更新」不会补装这两个包。
- 漏装时，required `contributions` 的插件停在 pending，启动日志对每个这样的插件打印 `插件 "<id>" 依赖未满足，未激活（缺少服务: …）`，列出缺少的服务名。

## 相关

- 契约：[api-contributions](../api/api-contributions.md)
- 钩子的默认提供者：[plugin-hooks](./plugin-hooks.md)
