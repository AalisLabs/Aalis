# plugin-events — 事件总线

**包名**: `@aalis/plugin-events`  
**源码**: `packages/plugin-events/src/index.ts`

## 概述

`events` 服务的默认提供者，契约见 [api-events](../api/api-events.md)。core 不内置事件总线；gateway、agent、session-manager、tools 等插件都 required `events`，部署时须装上本插件。

## 插件声明

```ts
export default definePlugin({
  name: '@aalis/plugin-events',
  displayName: '事件',
  subsystem: 'core',
  provides: [events],
  uses: { provide, logger },
  apply({ provide, logger }) { /* 见源码 */ },
});
```

无配置项。

## 行为

- **次序**：`on` 按登记序 `order` 升序插入该事件的监听器表。平常是新号追加到表尾；换提供者时各插件的登记整批重挂，按登记序还原原来的交错次序。
- **派发**：`emit` 开始时对监听器表做快照，逐个调用并等待。派发途中新登记的监听器不进入本次派发，途中已退订的跳过。
- **隔离**：监听器抛错时经本插件的日志器记 warn：`事件 "<event>" 的监听器抛错（已隔离，来自 <contextId>）:`，附上错误对象；其余监听器照常执行，`emit` 不被拒。记录本身出错不影响派发。
- **退订**：只撤对应的那一条，重复调用无副作用；监听器表清空时删除该事件的表项。
- **归属**：登记的归属与撤回由绑定门面的归属表负责，激活关闭时与服务登记同一拍撤回；本插件只按条目身份删除。

## 部署

- `npm create aalis` 的 minimal / standard / full 档已包含本插件；bare 档不带任何插件，需自行安装。
- npm 加载器只发现项目 `package.json` 的直接依赖：本插件要写进项目依赖（`npm i @aalis/plugin-events`），市场的「更新」不会补装它。
- 在管理页停用本插件时，required `events` 的插件随之停在 pending；提供管理页的 plugin-webui-server 与界面语言的 plugin-i18n 把 `events` 声明为可选，照常在线，界面文字照常翻译，可以在管理页重新启用。
- 漏装时，required `events` 的插件停在 pending，启动日志对每个这样的插件打印 `插件 "<id>" 依赖未满足，未激活：缺少服务 events（没有已装的插件提供）`，缺的服务沿依赖链追到根。
- 嵌入式宿主把本插件与其余插件放进同一批 `app.pluginAll`，拓扑排序会让它先于消费者激活；也可以在宿主根上直接提供：`app.bind({ provide }).provide.use(events, new Bus(app.logger))`（`Bus` 从本包导入）。

## 相关

- 契约：[api-events](../api/api-events.md)
- 钩子与贡献点的默认提供者：[plugin-hooks](./plugin-hooks.md)、[plugin-contributions](./plugin-contributions.md)
