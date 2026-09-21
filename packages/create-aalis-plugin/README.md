# create-aalis-plugin

Aalis 插件交互式脚手架。

## 安装

```bash
pnpm add create-aalis-plugin
```

也可 `npx create-aalis-plugin`。

## 提供 / 依赖

生成插件骨架包：`package.json`、`tsconfig.json`、`src/index.ts`（`definePlugin`）、`README.md`。可选特性会写入对应 api 包依赖与 `uses`（`tools` / `commands` / `webui-server`）。本包本身不是插件，无 `provides` / `uses`。

生成物的 `@aalis/core` peer 区间为 `>=0.17.0 <1.0.0`。

## 文档

详见 [docs/guide/scaffolding.md](../../docs/guide/scaffolding.md)。

## 许可

见仓库根目录 LICENSE。
