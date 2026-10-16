# @aalis/api-doctor

诊断子系统契约：检查项注册、报告类型与 `doctor` 描述符，以及插件没起来时「缺」与「在等」的共享判据 `unmetDependencies`（沿依赖链追到根，runtime 的启动告警、诊断、WebUI、终端界面与市场的卸载闸共用）。

插件失败给人看的说明：`failureText(entry)` 挂了文字对象的错误取它，其次按 core 自己的失败 code 给本包字典的说明，再其次用 core 给的摘要 `error`，没有失败时为 `undefined`。出口只交出这里给的说明，不下发失败的原值。

检查结果的 `message`、`detail`，以及 `describeUnmet`、`failureText` 给的说法可以是 `@aalis/schema-i18n` 的文字对象（本包字典的 ns 是 `@aalis/api-doctor`），出口按读者语言渲染，日志取原文（`toSource`）。

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
