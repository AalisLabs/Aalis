# plugin-session-confirm — 会话确认协调器

**包名**: `@aalis/plugin-session-confirm`  
**源码**: `packages/plugin-session-confirm/src/index.ts`

## 概述

权限模型「轴 B · 确认」的执行者：当一个已授权的操作声明了 `confirm`（典型是 `exec`、`file_write` 这类 `risk: 'dangerous'` 工具），authority 需要向发起者本人确认一次意图。本插件实现平台无关的协调器（待确认登记、60 秒超时、解析 `Y` / `YS`、提示文案），并经 gateway 总线覆盖 OneBot、CLI 等只靠消息总线的会话型平台（CLI 的提示进聊天区、在输入框回复）。

没有它时，会话型平台上任何声明 `confirm` 的工具都只会得到「操作已取消：需确认后执行，但平台 … 没有确认通道」，无法执行；owner 只能用 `/auto` 临时免确认。因此 `npm create aalis` 从 minimal 档起就把它装上。WebUI 的 WS 确认通道同样依赖本插件：webui-server 在 `session-confirm` 服务就绪后才用它的协调器建通道并注册 `'webui'` 回调，本插件缺席或被禁用时 WebUI 也没有确认通道。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-session-confirm',
  provides: [sessionConfirm],
  uses: {
    gateway,
    authority: optional(authority),
    hooks,
    lifecycle,
    logger,
    provide,
  },
  apply(caps) { /* 见源码 */ },
});
```

## 行为

- 向 authority 注册 `'*'` 通配确认回调（精确平台回调优先，如 WebUI 的 `'webui'`）；`setConfirmHandler` 返回的注销函数在插件 dispose 时调用，禁用 / 卸载后 authority 立即知道「无通道」而不是把请求投给已死的回调等到超时。
- 确认提示经 gateway 出站发到发起会话，带参数摘要（只展示 `command` / `name` / `processId` / `path` / `from` / `to` / `uri` / `url` 的首行，限 120 字符，其它参数不外露）；用户回复在 `inbound:confirm` 相位（入站最前）被拦截解析并吞掉，不会触达 agent。
- 发起确认的回合被中止（新消息 latest-wins 或手动 abort，即 `AccessRequest.signal` 触发）时，这条未决确认被撤回并按取消结算，队列推进到下一个；已中止的回合发起的确认不入队直接拒。
- 回复语义：`Y` 仅允许本次；`YS` 本会话 10 分钟内放行同一能力；`confirm: 'always'` 的操作不记会话授予，`YS` 只按允许本次处理；其他任意输入取消；60 秒无回复视为取消。
- 只有触发者本人的回复有效，群里第三方抢答无效。

## 配置

无配置项。

## 相关

- 服务契约与 `createChannel(deliver)` 工厂：[services/session-confirm.md](../services/session-confirm.md)
- 两轴权限模型：[plugin-authority.md](./plugin-authority.md)
