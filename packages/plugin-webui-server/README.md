# @aalis/plugin-webui-server

Web 管理界面后端：对话/插件/服务/市场/文件
## 角色

运行时插件

## 安装

```bash
pnpm add @aalis/plugin-webui-server
```

## 宿主路径

以 `optional(hostPaths)` 声明 `host-paths`（`@aalis/api-host-paths`），从安装集扫描本机包与前端。宿主不提供时发现不到前端，整个 WebUI 前端不可用，只剩 HTTP 接口，市场与系统组件接口返回 503。Node 宿主 `@aalis/runtime` 总会提供它。

## 文档

详见 [docs/plugins/plugin-webui-server.md](../../docs/plugins/plugin-webui-server.md)。

## 许可

见仓库根目录 LICENSE。
