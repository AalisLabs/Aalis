# @aalis/api-code-sandbox

代码沙箱契约：在 OS 隔离下执行不可信代码的服务接口（code_runner 等消费）

## 安装

```bash
pnpm add @aalis/api-code-sandbox
```

## 提供

服务描述符：`codeSandbox`（服务名 `code-sandbox`）。

```ts
import { codeSandbox } from '@aalis/api-code-sandbox';
```

实现见 `@aalis/plugin-code-sandbox-os`。

## 文档

详见 [docs/services/code-sandbox.md](../../docs/services/code-sandbox.md)。

## 许可

见仓库根目录 LICENSE。
