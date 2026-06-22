# cron-engine 服务

## 1. 定位

`cron-engine` 是 Aalis 的**共享定时引擎原语**：把「cron 表达式 / 别名 / `@every` 间隔」解析为统一的订阅协议，所有周期型触发器（scheduler 任务、workflow 的 cron/interval 触发器）都挂接到它共享的一条整分钟 tick 上，而不是各自 `setInterval`。

- 服务注册名：`getService('cron-engine')`（`packages/plugin-cron-engine-api/src/index.ts:232-234`）。
- 契约包：`@aalis/plugin-cron-engine-api`（纯类型 + 无状态纯函数）。
- 参考实现：`@aalis/plugin-cron-engine`（`packages/plugin-cron-engine/src/index.ts`）。

注意它**只负责定时与触发**，不负责任务定义、持久化、权限或执行——那些属于上层（scheduler / workflow）。失败的 handler 仅记日志，不影响其他订阅者（`packages/plugin-cron-engine/src/index.ts:6-7`）。

## 2. 契约

### 2.1 服务接口 `CronEngine`

`packages/plugin-cron-engine-api/src/index.ts:207-228`：

```ts
export interface CronEngine {
  // 订阅一个 cron / @every 表达式，返回 dispose 函数；失败抛 Error（建议先 validate）
  subscribe(
    expr: string,
    handler: () => void | Promise<void>,
    options?: CronSubscribeOptions,
  ): () => void;                                    // :216

  // 表达式校验
  validate(expr: string): ValidateResult;            // :219

  // 从 from 起向前找下一次触发时间戳（ms）；cron 在 lookaheadMinutes（默认 366*24*60）内未命中返回 null
  nextFireTime(
    expr: string,
    from?: Date,
    lookaheadMinutes?: number,
    options?: CronSubscribeOptions,
  ): number | null;                                  // :227
}
```

`CronSubscribeOptions`（`...:198-205`）只有一个可选字段 `timeZone?: string`——IANA 时区名（如 `Asia/Shanghai`）。空串/未传 = 进程本地时区；**只对 5 字段 cron 生效，`@every` interval 与时区无关**。

### 2.2 表达式类型与校验结果

`...:158-162`：

```ts
export type CronExprKind = 'cron' | 'interval';

export type ValidateResult =
  | { ok: true; kind: CronExprKind; normalized: string; intervalSeconds?: number }
  | { ok: false; reason: string };
```

`validate`（即 `validateCronExpr`，`...:167-193`）是创建期的护栏：逐字段校验，任一字段解析为空集（如 `abc`、`5-`、超界单值）即拒绝，避免静默生成永不触发的死任务。

### 2.3 无状态纯函数（可独立 import，不必经服务）

契约包同时直接导出一组无状态函数，scheduler / workflow 也在编译期 import 它们做预处理：

| 函数 | 签名 | 用途 | 行 |
| --- | --- | --- | --- |
| `normalizeCronExpr` | `(input: string) => string \| null` | 别名（`@daily` 等）展开为 5 字段；`@every` 原样；不识别返回 null | `:17` |
| `parseCronField` | `(field, min, max) => Set<number>` | 解析单字段命中集合，支持 `*` `*/5` `1-5` `1,3,5` `1-30/5` `0/15` | `:40` |
| `dateFieldsInTimeZone` | `(date, timeZone?) => {minute,hour,day,month,weekday}` | 按时区拆 Date 为 cron 字段数字 | `:77` |
| `matchesCron` | `(expr, date, timeZone?) => boolean` | 判断某时刻是否命中（不处理 `@every`） | `:124` |
| `parseEverySeconds` | `(input: string) => number` | 把 `@every 30s/5m/2h` 解析为秒；不识别返回 0 | `:143` |
| `validateCronExpr` | `(input) => ValidateResult` | 见 §2.2 | `:167` |
| `useCronEngine` | `(ctx: Context) => CronEngine` | 取服务的便捷封装，缺失即抛 | `:237` |

支持的表达式：5 字段标准 cron、别名 `@hourly` `@daily` `@midnight` `@weekly` `@monthly` `@yearly` `@annually`（`:20-28`）、以及间隔 `@every Ns`/`Nm`/`Nh`（`:143-154`）。

## 3. 谁提供 / 谁消费

**提供方（唯一参考实现）**：`@aalis/plugin-cron-engine`
- `provides = ['cron-engine']`（`packages/plugin-cron-engine/src/index.ts:25`）
- `package.json` 双源对应 `aalis.service.provides: ['cron-engine']`（`packages/plugin-cron-engine/package.json`）
- 注册点 `ctx.provide('cron-engine', service)`（`...src/index.ts:143`）

**消费方**：

- `@aalis/plugin-scheduler`：`inject.required = ['tools', 'cron-engine']`（`packages/plugin-scheduler/src/index.ts:123-126`）。`const cronEngine = useCronEngine(ctx)`（`:371`），cron 任务 `cronEngine.subscribe(jobCfg.cron, ..., tz ? { timeZone: tz } : undefined)`（`:570-578`），并用 `cronEngine.nextFireTime(job.cron, new Date(), undefined, tz ? {timeZone} : undefined)` 估算下次运行（`:523`）。注意它在 `initJob` 里先用 `parseEverySeconds` 把 `@every Ns` 折进自己的 interval 通道（`:534-540`）。
- `@aalis/plugin-workflow`：`inject.required = ['cron-engine']`（`packages/plugin-workflow/src/index.ts:34`）。`cron` 触发器 `useCronEngine(ctx).subscribe(t.expr, ...)`（`packages/plugin-workflow/src/triggers.ts:41-44`）；`interval` 触发器统一转成 `@every ${sec}s` 再 subscribe，避免与 scheduler 维护两份 setInterval（`triggers.ts:50-58`）。

## 4. 写一个 provider

绝大多数作者**不需要**再写 provider——官方 `@aalis/plugin-cron-engine` 已是唯一实现，重复 provide 同名服务只会按 `preference > priority > 注册顺序` 决出一个赢家（见 [service-model](../concepts/service-model.md)）。仅当你要替换调度后端（例如换持久化的分布式定时）时才自行实现。

最小必须实现 = 接口三个方法 `subscribe / validate / nextFireTime`。可选 = `timeZone` 支持（不支持时建议忽略该参数并按本地时区评估，行为退化但不报错）。可直接复用契约包的纯函数完成校验与匹配，骨架如下：

```ts
import type { Context } from '@aalis/core';
import {
  type CronEngine,
  type CronSubscribeOptions,
  matchesCron,
  normalizeCronExpr,
  parseEverySeconds,
  validateCronExpr,
} from '@aalis/plugin-cron-engine-api';

export const name = 'my-cron-backend';
export const provides = ['cron-engine'];          // ← 双源之一

export function apply(ctx: Context): void {
  const logger = ctx.logger;
  const cronSubs = new Map<number, { normalized: string; handler: () => void | Promise<void>; tz?: string }>();
  let nextId = 1;

  const service: CronEngine = {
    subscribe(expr, handler, options?: CronSubscribeOptions) {
      const v = validateCronExpr(expr);
      if (!v.ok) throw new Error(v.reason);          // 失败抛 Error，与契约一致
      const id = nextId++;
      if (v.kind === 'interval') {
        const timer = setInterval(() => void handler(), (v.intervalSeconds ?? 0) * 1000);
        return () => clearInterval(timer);
      }
      const tz = options?.timeZone?.trim() || undefined;
      cronSubs.set(id, { normalized: normalizeCronExpr(expr)!, handler, tz });
      // …把 id 挂到你的整分钟 tick；handler 异常须 try/catch，不得让一个订阅者拖垮其余
      return () => { cronSubs.delete(id); };
    },
    validate(expr) {
      return validateCronExpr(expr);
    },
    nextFireTime(expr, from = new Date(), lookaheadMinutes = 366 * 24 * 60, options) {
      const v = validateCronExpr(expr);
      if (!v.ok) return null;
      if (v.kind === 'interval') return from.getTime() + (v.intervalSeconds ?? 0) * 1000;
      const tz = options?.timeZone?.trim() || undefined;
      const start = new Date(from); start.setSeconds(0, 0); start.setMinutes(start.getMinutes() + 1);
      for (let i = 0; i < lookaheadMinutes; i++) {
        const c = new Date(start.getTime() + i * 60_000);
        if (matchesCron(v.normalized, c, tz)) return c.getTime();
      }
      return null;
    },
  };

  ctx.provide('cron-engine', service);
  ctx.onDispose(() => { /* 清掉所有 timer 与订阅，见参考实现 :145-151 */ });
}
```

注册时 `ctx.provide('cron-engine', service)` 不需要 `entryId`（单 entry、无需 per-entry 拆分），`priority` 默认 `ServicePriority.Backend(0)` 即可，要盖过官方实现可用 `Override(50)`。**双源同步**：`package.json` 里也要写

```jsonc
"aalis": { "service": { "provides": ["cron-engine"] } }
```

与代码里的 `export const provides = ['cron-engine']` 一致（参考实现 `package.json` + `index.ts:25`）。详见 [manifest-metadata](../concepts/manifest-metadata.md)。

实现要点（照搬参考实现）：
- 多订阅者**共享一条对齐到整分钟的 tick**（`ensureCronLoop` 用 `setTimeout` 对齐到下一整分钟再 `setInterval(_, 60_000)`，`...src/index.ts:48-58`），`cronTick` 把当前分钟的秒/毫秒清零后逐个 `matchesCron`（`:60-75`）。
- handler 必须包 try/catch，且对 Promise 返回值 `.catch` 记日志——**一个订阅者抛错不能影响其余**（`:64-74`、`:85-92`）。
- `subscribe` 里若给了 `timeZone`，应提前 `new Intl.DateTimeFormat({ timeZone })` 探测合法性并抛「非法时区」，不要拖到分钟 tick 才静默失败（`:106-113`）。
- `onDispose` 清空所有 timer 与订阅表（`:145-151`）。

## 5. 标准消费姿势

1. 在 `inject.required` 声明 `'cron-engine'`，让运行时保证服务就绪后才 `apply`（scheduler `:123-126`、workflow `:34`）。
2. 用 `useCronEngine(ctx)` 取服务——它内部就是 `getService<CronEngine>('cron-engine')`，缺失即抛带提示的 Error（`...api/src/index.ts:237-241`）。**不要缓存返回值**：provider 反弹会失效，每次用时重新取（见 [lazy-service-access](../concepts/lazy-service-access.md)）。
3. 创建前先 `validate` 或捕获 `subscribe` 的抛错——参考实现两个消费方都用 `try/catch` 包住 subscribe 并 `logger.warn`，避免一条坏表达式中断整批注册（scheduler `:579-581`、workflow `triggers.ts:45-47`）。
4. 保存好 `subscribe` 返回的 dispose，在任务删除/禁用/插件卸载时调用（scheduler 存 `rt.cronDispose`、workflow 存 `cronDisposers` Map）。
5. 可选依赖：若你的插件在没有 cron-engine 时仍能降级运行，则不要放进 `required`，改为运行时 `const eng = ctx.getService<CronEngine>('cron-engine')` 判空处理。

`@every Ns` 与 5 字段 cron 都可直接交给 `subscribe`——无需自己预 normalize（scheduler `:540` 注释）。`interval` 语义统一委托 `@every Ns` 表达式，别再自己起 `setInterval`（workflow `triggers.ts:50-51` 注释）。

## 6. 能力 / 风险 → 影响

`cron-engine` 本身**不触及 authority、storage、网络**——它只回调 handler。安全责任完全落在 handler 内部和上层：

- **触发无人类调用者 → 匿名最低权限**。cron/interval/event 触发器没有触发人，workflow 据此把这类运行视作匿名 level-0，**只能跑 public 工具**，杜绝借他人 workflow 提权（`packages/plugin-workflow/src/index.ts:422-424`）。你的 handler 若要执行带风险的动作，必须自己经 [authority](../concepts/security-model.md) 闸，且不能假冒 owner 身份。
- **handler 隔离**：provider 保证单个 handler 抛错不波及其他订阅者，但 handler 自身**不得阻塞**——它跑在共享 tick 上，长任务应 `void`/fire-and-forget（scheduler 与 workflow 都是异步 fire，不阻塞 tick）。
- **风险标注的副作用**属于上层工具调用，不在本服务范畴；定时只是触发器。

## 7. 边界与坑

- **最小粒度是分钟**：cron tick 对齐整分钟、`cronTick` 把秒清零（`...src/index.ts:62`），秒级 cron 不支持；要更细只能用 `@every Ns`（走独立 `setInterval`）。
- **`@every` 不参与 cron 匹配也不认时区**：`matchesCron`/`normalizeCronExpr` 对 `@every` 直接放过/原样返回（`api/src/index.ts:19,126`），间隔从注册时刻起算、`timeZone` 对它无意义。
- **`nextFireTime` 有上限**：cron 在 `lookaheadMinutes`（默认 366×24×60 ≈ 一年零一天）内没命中就返回 `null`，极稀疏的表达式（如 `2/30` 月）可能落空。
- **进程内、非持久化**：所有订阅都是内存 timer，进程重启即丢；持久化任务定义、重启恢复属上层（scheduler/workflow 各自落盘后重新 `subscribe`）。**进程停机期间错过的触发不会补跑**。
- **`day` 与 `weekday` 取交集而非并集**：`matchesCron` 用 `&&` 串联五个字段（`api/src/index.ts:131-137`），与 Vixie cron「日/周谁限定取并集」的传统行为**不同**——同时写日和周会变成「既是某日又是某周几」才触发。
- **字段越界被静默夹取**：`parseCronField` 把范围夹到 `[min,max]`（`:64-65`），如分钟字段 `1-100` 不会塞入 60-99；但**整字段解析为空集**会在 `validate` 阶段被拒（`:187-191`），不会生成死任务。
- **`午夜 hour=24` 的修正**：用 IANA 时区且 `hour12=false` 时 Intl 午夜可能返回 `"24"`，已换回 `0` 以匹配 cron 0-23（`:105-107`）——自实现 provider 别漏这点。

## 8. 交叉链接

- 概念：[service-model](../concepts/service-model.md)（DI 按名选择 / priority / entryId）、[lazy-service-access](../concepts/lazy-service-access.md)（每次 getService，勿缓存）、[manifest-metadata](../concepts/manifest-metadata.md)（`provides` 双源）、[security-model](../concepts/security-model.md)（触发身份与 authority）。
- 核心：[core/service](../core/service.md)、[core/context](../core/context.md)、[core/authority](../core/authority.md)、[core/events](../core/events.md)（workflow 经 `trigger:fired` / `ctx.on` 串联事件触发）。
- 服务：[services/tools](./tools.md)（被触发的执行单元）、上层的 scheduler / workflow 插件即本服务的两个标准消费方。
