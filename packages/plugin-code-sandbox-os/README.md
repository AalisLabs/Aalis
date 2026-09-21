# @aalis/plugin-code-sandbox-os

代码沙箱（OS 原生）：Linux bubblewrap / macOS sandbox-exec 隔离不可信代码执行

## 安装

```bash
pnpm add @aalis/plugin-code-sandbox-os
```

## 提供 / 依赖

`definePlugin` 默认导出：

- provides：`codeSandbox`（服务名 `code-sandbox`）
- uses：`processService`（`process`）、`logger`、`provide`

## 文档

详见 [docs/plugins/plugin-code-sandbox-os.md](../../docs/plugins/plugin-code-sandbox-os.md)。

## 许可

见仓库根目录 LICENSE。
