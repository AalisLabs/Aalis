# create-aalis

Aalis 快速初始化脚手架：交互式选插件，生成独立项目与它的家目录 `home/`。

## 安装

```bash
pnpm add create-aalis
```

也可 `npm create aalis@latest`。

## 提供 / 依赖

生成可运行的独立项目：家目录 `home/`（主配置 `aalis.config.yaml`，密钥也填在这里；另有一份空的 `secrets.yaml`，目前不读取）与 `startAalis()` 入口，按模板档写入 `@aalis/core`、`@aalis/runtime` 及所选插件。本包本身不是插件，无 `provides` / `uses`。

## 文档

详见 [docs/guide/scaffolding.md](../../docs/guide/scaffolding.md)。

## 许可

见仓库根目录 LICENSE。
