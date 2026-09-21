# @aalis/api-platform

平台适配器契约：连接状态、自身身份与适配器登记。

## 安装

```bash
pnpm add @aalis/api-platform
```

## 提供

服务描述符：`platform`（服务名 `platform`）。

```ts
import { platform } from '@aalis/api-platform';
```

实现由各平台插件提供（如 `@aalis/plugin-cli`、`@aalis/plugin-adapter-onebot`）。

## 文档

详见 [docs/services/platform.md](../../docs/services/platform.md)。

## 许可

见仓库根目录 LICENSE。
