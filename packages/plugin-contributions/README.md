# @aalis/plugin-contributions

`contributions` 服务的默认提供者：贡献点登记表。契约见 `@aalis/api-contributions`。

- provides：`contributions`
- uses：`provide`
- 全局键为 `激活 id/局部 id`，同键为替换，旧退订按条目身份失效；`collect` 按全局键码元序给出快照，spec 按引用给出。

使用贡献点的插件（agent、adapter-onebot、memory-* 等）都 required `contributions`，部署时须装上本插件。`npm create aalis` 的 minimal 及以上各档已包含；bare 档不带任何插件，需自行安装。已有项目升级到 0.18 时执行 `npm i @aalis/plugin-hooks @aalis/plugin-contributions`：市场的「更新」不会补装新依赖。
