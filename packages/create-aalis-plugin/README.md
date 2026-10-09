# create-aalis-plugin

Aalis 插件交互式脚手架。

## 用法

```bash
npm create aalis-plugin@latest my-plugin
npm create aalis-plugin@latest my-plugin -- --yes --registry <源地址>   # 全取默认；--registry 指定查依赖版本用的 npm 源
```

## 提供 / 依赖

生成插件骨架包：`package.json`、`tsconfig.json`、`src/index.ts`（`definePlugin`）、`README.md`。可选特性会写入对应 api 包依赖与 `uses`（`tools` / `commands` / `webui-server` / `session-manager`）；WebUI 页面选了自带前端时另生成 `webui/index.html` 与 `webui/main.js`（插件前端，不用构建），`files` 带上 `webui`。本包本身不是插件，无 `provides` / `uses`。

生成物的 `@aalis/core` peer 区间为 `>=0.17.0 <1.0.0`；api 包依赖与 core 开发依赖写 `>=<源上的最新版> <1.0.0`，查不到版本时退出并写明是哪个包。

## 文档

详见 [docs/guide/scaffolding.md](../../docs/guide/scaffolding.md)。

## 许可

见仓库根目录 LICENSE。
