# @aalis/plugin-webui-client-example

最小的 Aalis **示例前端**，演示「忒修斯之船——webui-server 前端可热切换」。

- **不是插件**，是「前端」：`package.json` 标 `aalis.client: true`（无 `apply`，runtime 不加载它）。
- webui-server 启动时**按标记动态发现**所有带 `aalis.client` + `dist/index.html` 的包，无硬编码包名。
- **`private: true`**：永不发布到 npm；仅作仓库内可复用示范（第三方写自己的前端可照此结构）。

## 怎么试
1. `pnpm install && pnpm -r build`（或单独 `pnpm --filter @aalis/plugin-webui-client-example build`）。
2. 启动带 webui-server 的 Aalis。
3. 打开默认前端 **Dashboard 的「服务」区**，找到 `webui-client` 服务卡片的**下拉框**（多 provider 时出现），选「示例前端」。
4. 页面平滑 reload 后即由本示例前端接管；切回默认前端 = 同一下拉框选回，或点「恢复默认」。

> 前端切换统一走「服务偏好」（`webui-client` 是多 provider 服务）；没有单独的切换开关。

第三方做自己的前端：建个包，`package.json` 标 `aalis.client: true`，构建出 `dist/index.html`，
作为依赖装进你的 Aalis 项目（或放进 monorepo `packages/`）即可被发现。
