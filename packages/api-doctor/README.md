# @aalis/api-doctor

诊断子系统契约：检查项注册、报告类型与 `doctor` 描述符，以及插件没起来时「缺」与「在等」的共享判据 `unmetDependencies`（沿依赖链追到根，runtime 的启动告警、诊断、WebUI 与终端界面共用）。

## 安装

```bash
pnpm add @aalis/api-doctor
```

## 提供

服务描述符：`doctor`（服务名 `doctor`）。

```ts
import { doctor } from '@aalis/api-doctor';
```

实现见 `@aalis/plugin-doctor`。

## 文档

详见 [docs/services/doctor.md](../../docs/services/doctor.md)。

## 许可

见仓库根目录 LICENSE。
