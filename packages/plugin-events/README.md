# @aalis/plugin-events

`events` 服务的默认提供者：事件总线。契约见 `@aalis/api-events`。

- provides：`events`
- uses：`provide`、`logger`
- 监听器抛错时经本插件的 logger 记一条 warn，点名事件与登记它的插件；其余监听器照常执行。
- 派发途中被退订的监听器跳过。归属与撤回由绑定门面的归属表负责，激活关闭时与服务登记同一拍撤回。

gateway、agent、session-manager、tools 等插件都 required `events`，部署时须装上本插件；`@aalis/plugin-webui-server` 对它是可选依赖，本插件停用时管理页照常在线。`npm create aalis` 的 minimal 及以上各档已包含；bare 档不带任何插件，需自行安装。嵌入式宿主把它与其余插件放进同一批 `app.pluginAll` 即可，拓扑排序会让它先于消费者激活。
