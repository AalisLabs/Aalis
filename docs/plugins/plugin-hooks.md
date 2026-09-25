# plugin-hooks — 钩子登记表

**包名**: `@aalis/plugin-hooks`  
**源码**: `packages/plugin-hooks/src/index.ts`

## 概述

`hooks` 服务的默认提供者，契约见 [api-hooks](../api/api-hooks.md)。core 不内置钩子；gateway、agent、commands、flow-control、session-manager、media 等插件都 required `hooks`，部署时须装上本插件。

## 插件声明

```ts
export default definePlugin({
  name: '@aalis/plugin-hooks',
  displayName: '钩子',
  subsystem: 'core',
  provides: [hooks],
  uses: { provide, logger },
  apply({ provide, logger }) { /* 见源码 */ },
});
```

无配置项。

## 行为

- **链序**：`register` 按登记序 `order` 升序插入该钩子的链。平常是新号追加到链尾；换提供者时各插件的登记整批重挂，按登记序还原原来的交错次序。
- **快照遍历**：`run` 开始时对链做快照，执行途中新登记的 handler 不进入本次遍历，途中已撤回的 handler 跳过。
- **退订**：只撤对应的那一条，重复调用无副作用；链清空时删除该钩子的表项。
- **卡链告警**：`run` 带 `warnOnStall` 时，某个 handler 没有调用 `next()`、且其后还有 handler，经本插件的日志器告警：`钩子 <hook>: handler(来自 <contextId>) 未调用 next()，其后 <N> 个 handler 被跳过`。告警本身出错不影响主流程。
- **归属**：登记的归属与撤回由绑定门面的账本负责，激活关闭时与事件、服务登记同一拍撤回；本插件只按条目身份删除。

## 部署

- `npm create aalis` 的 minimal / standard / full 档已包含本插件与 [plugin-contributions](./plugin-contributions.md)；bare 档不带任何插件，需自行安装。
- 已有项目需执行 `npm i @aalis/plugin-hooks @aalis/plugin-contributions`。npm 加载器只发现项目 `package.json` 的直接依赖，市场的「更新」不会补装这两个包。
- 漏装时，required `hooks` 的插件停在 pending，启动日志对每个这样的插件打印 `插件 "<id>" 依赖未满足，未激活（缺少服务: …）`，列出缺少的服务名。
- 嵌入式宿主把本插件与其余插件放进同一批 `app.pluginAll`，拓扑排序会让它先于消费者激活。

## 相关

- 契约：[api-hooks](../api/api-hooks.md)
- 贡献点的默认提供者：[plugin-contributions](./plugin-contributions.md)
