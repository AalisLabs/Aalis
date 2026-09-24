# @aalis/plugin-hooks

`hooks` 服务的默认提供者：钩子登记表。契约见 `@aalis/api-hooks`。

- provides：`hooks`
- uses：`provide`、`logger`
- 广播型相位（`run` 带 `warnOnStall`）里某个 handler 没调 `next()` 时，经本插件的 logger 点名告警。
- 运行途中被撤回的 handler 跳过。归属与撤回由绑定门面的账本负责，激活关闭时与事件、服务登记同一拍撤回。

使用钩子的插件（agent、gateway、commands 等）都 required `hooks`，部署时须装上本插件。`npm create aalis` 的各档都已包含。嵌入式宿主把它与其余插件放进同一批 `app.pluginAll` 即可，拓扑排序会让它先于消费者激活。
