# create-aalis-plugin

Aalis 插件交互式脚手架。

## 用法

```bash
npm create aalis-plugin@latest my-plugin
npm create aalis-plugin@latest my-plugin -- --yes --registry <源地址>   # 全取默认；--registry 指定查依赖版本用的 npm 源
npm create aalis-plugin@latest my-plugin -- --yes --lang en              # 原文语言写英文（zh-CN 或 en），终端也按它显示
```

终端里的文字按系统语言显示（中文或英文，别的语言按英文）；没给 `--lang` 时问原文语言，缺省按系统语言。

## 提供 / 依赖

生成插件骨架包：`package.json`、`tsconfig.json`（NodeNext）、`src/index.ts`（`definePlugin`）、给人看的文字的原文字典 `src/texts.ts` 与另一种语言的译文 `src/locales/<语言>.ts`、字典自检用例 `test/texts.test.js`（`npm test`）、`README.md`。可选特性会写入对应 api 包依赖与 `uses`（`tools` / `commands` / `webui-server` / `session-settings` / `host-config`）；WebUI 页面选了自带前端时另生成 `webui/index.html` 与 `webui/main.js`（插件前端，不用构建，文字经 `frame.t` 取自字典），`files` 带上 `webui`。本包本身不是插件，无 `provides` / `uses`；运行时依赖 `@aalis/schema-i18n`（终端文字的字典）。

生成物的 `@aalis/core` peer 区间为 `>=0.21.0 <1.0.0`（显示名与页面标题是文字对象，core 0.21 起才收）；`@aalis/schema-i18n`、api 包依赖与 core 开发依赖写 `>=<源上的最新版> <1.0.0`，查不到版本时退出并写明是哪个包。

## 文档

详见 [docs/guide/scaffolding.md](../../docs/guide/scaffolding.md)。

## 许可

见仓库根目录 LICENSE。
