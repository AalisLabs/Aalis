# doctor 服务 — 自检诊断注册中心

> 面向：要给 Aalis **贡献一条健康检查项**（最常见，consumer 角度），或要**替换/自建诊断聚合后端**（provider 角度）的第三方作者。

`doctor` 是一个**开放注册中心**：各业务插件把「自己领域是否健康」的探测逻辑注册进来，doctor 负责聚合、跑全套、出报告。注册名是字符串 **`'doctor'`**（`ctx.getService('doctor')`），契约包是 [`@aalis/plugin-doctor-api`](../../packages/plugin-doctor-api/src/index.ts)。

为什么单独抽出 `-api` 包：如果 storage / commands 等下游插件直接 `runtime depend` 实现包 `plugin-doctor` 才能注册检查项，就会形成「实现包 ↔ 业务插件」双向耦合。仿照 storage-api / commands-api 的做法，把**类型 + 一个 `useDoctorService` helper** 抽到 `-api`，业务插件只依赖契约，doctor 自身不反向硬依赖任何业务插件（[`plugin-doctor-api/src/index.ts:1-16`](../../packages/plugin-doctor-api/src/index.ts)；实现侧注释 [`plugin-doctor/src/index.ts:169-176`](../../packages/plugin-doctor/src/index.ts)）。

参考实现：[`@aalis/plugin-doctor`](../../packages/plugin-doctor/src/index.ts)（唯一 provider，内置 `env.node` / `env.platform` / `plugins.status` 三条「与领域无关」的检查）。典型 consumer：[`@aalis/plugin-storage-local`](../../packages/plugin-storage-local/src/index.ts)（注册 `storage.roots` 探测可写性）、[`@aalis/plugin-webui-server`](../../packages/plugin-webui-server/src/index.ts)（订阅 `doctor:updated` 事件刷新 WebUI）。

---

## 1. 契约：类型与服务接口

全部定义在 [`plugin-doctor-api/src/index.ts`](../../packages/plugin-doctor-api/src/index.ts)。

### 检查结果与报告（[`index.ts:22-37`](../../packages/plugin-doctor-api/src/index.ts)）

```ts
export type CheckLevel = 'ok' | 'warn' | 'error';
export type CheckCategory = 'env' | 'filesystem' | 'plugins' | 'config' | 'service' | 'other';

export interface CheckResult {
  id: string;            // 结果 id，可与 spec.id 不同（一个 spec 可产出多条带不同 id 的结果）
  category: CheckCategory;
  level: CheckLevel;
  message: string;       // 一行人类可读结论
  detail?: string;       // 可选多行详情（错误栈、命中清单等），\n 分隔
}

export interface DoctorReport {
  generatedAt: string;   // ISO 时间戳
  summary: { ok: number; warn: number; error: number };
  checks: CheckResult[];
}
```

### 检查项定义 `CheckSpec`（[`index.ts:40-51`](../../packages/plugin-doctor-api/src/index.ts)）

```ts
export interface CheckSpec {
  id: string;            // 唯一 id，如 'memory.connectivity'；重复注册以最后一次为准
  category: CheckCategory;
  label?: string;        // 仅用于日志/调试显示
  pluginName?: string;   // 来源插件名；useDoctorService 会自动注入 ctx.id
  run(ctx: Context): Promise<CheckResult | CheckResult[]> | CheckResult | CheckResult[];
}
```

要点：`run` 可以**同步或异步**，可返回**单条或多条** `CheckResult`——一个 spec 通常对应一个领域（如 `storage.roots`），但可以为每个被探测对象产出一条结果（[`plugin-storage-local/src/index.ts:702-712`](../../packages/plugin-storage-local/src/index.ts) 为每个 writable root 产一条）。

### 服务接口 `DoctorService`（[`index.ts:53-65`](../../packages/plugin-doctor-api/src/index.ts)）

```ts
export interface DoctorService {
  runChecks(): Promise<DoctorReport>;                 // 跑全部检查，写入 last，发 'doctor:updated'
  getLastReport(): DoctorReport | undefined;          // 取上次报告；从未运行过为 undefined
  registerCheck(spec: CheckSpec): () => void;         // 注册；返回 dispose；同 id 覆盖
  listChecks(): Array<{ id: string; category: CheckCategory; pluginName?: string }>;
}
```

### 事件增强（[`index.ts:69-74`](../../packages/plugin-doctor-api/src/index.ts)）

`-api` 用 declaration merging 给 `@aalis/core` 的 `AalisEvents` 加了一条：

```ts
'doctor:updated': [info: { generatedAt: string; summary: { ok: number; warn: number; error: number } }];
```

每次 `runChecks()` 完成后发射（[`plugin-doctor/src/index.ts:90`](../../packages/plugin-doctor/src/index.ts)），供 WebUI 等订阅者即时刷新。只想拿到这条事件类型、不调服务的包，只需 `import type {} from '@aalis/plugin-doctor-api'` 触发合并即可（[`plugin-webui-server/src/index.ts:15`](../../packages/plugin-webui-server/src/index.ts)）。

### Helper `useDoctorService`（[`index.ts:97-106`](../../packages/plugin-doctor-api/src/index.ts)）

这是 consumer 注册检查项的**推荐入口**，封装了 doctor 未就绪时的延迟注册：

```ts
export interface ScopedDoctorService {
  registerCheck(spec: CheckSpec): () => void;  // 立即或延迟注册；返回 dispose
}
export function useDoctorService(ctx: Context): ScopedDoctorService;
```

内部用 `ctx.whenService<DoctorService>('doctor', svc => svc.registerCheck(filledSpec))`（[`index.ts:103`](../../packages/plugin-doctor-api/src/index.ts)），并自动把 `pluginName` 填成 `ctx.id`（[`index.ts:100`](../../packages/plugin-doctor-api/src/index.ts)）。

---

## 2. 谁提供 / 谁消费

| 角色 | 包 | 关键点 |
| --- | --- | --- |
| Provider（唯一） | `@aalis/plugin-doctor` | `ctx.provide('doctor', registry)`（[`index.ts:152`](../../packages/plugin-doctor/src/index.ts)）；内置 `env.node`/`env.platform`/`plugins.status`（[`index.ts:177-245`](../../packages/plugin-doctor/src/index.ts)）；挂 `/doctor` 命令 + WebUI 页面 |
| Consumer（注册检查项） | `@aalis/plugin-storage-local` | `useDoctorService(ctx).registerCheck({ id: 'storage.roots', ... })`（[`index.ts:698-713`](../../packages/plugin-storage-local/src/index.ts)） |
| Consumer（订阅结果） | `@aalis/plugin-webui-server` | `ctx.on('doctor:updated', () => broadcastPageRefresh(...))`（[`index.ts:1183`](../../packages/plugin-webui-server/src/index.ts)） |

注意：内置检查项与第三方检查项走**同一条 `registerCheck` 路径**，在 `listChecks()` / 报告里一视同仁（[`plugin-doctor/src/index.ts:154`](../../packages/plugin-doctor/src/index.ts)）。第三方贡献者并非二等公民。

---

## 3. 贡献一条检查项（最常见用法 — consumer）

99% 的第三方需求是「我的插件想上报自己领域是否健康」，而**不是**替换 doctor。直接用 helper 即可。

### 最小骨架

```ts
import type { Context } from '@aalis/core';
import { useDoctorService } from '@aalis/plugin-doctor-api';

export const name = '@aalis/plugin-my-feature';
// doctor 是可选依赖：列进 inject.optional，doctor 重启时才会带动本插件重挂 check
export const inject = { optional: ['doctor'] };

export function apply(ctx: Context): void {
  const dispose = useDoctorService(ctx).registerCheck({
    id: 'my-feature.connectivity',     // 领域前缀 + 子项，全局唯一
    category: 'service',
    async run(ctx) {
      const svc = ctx.getService('my-backend');     // 每次重新取，别缓存
      if (!svc) {
        return { id: 'my-feature.connectivity', category: 'service', level: 'warn', message: '后端服务未就绪' };
      }
      const ok = await svc.ping();
      return {
        id: 'my-feature.connectivity',
        category: 'service',
        level: ok ? 'ok' : 'error',
        message: ok ? '后端连通' : '后端不可达',
        detail: ok ? undefined : '检查网络 / 凭证配置',
      };
    },
  });
  // dispose 由 ctx 作用域负责清理；通常无需手动调
}
```

### 必须同步两处清单元数据

doctor 作为可选依赖，要让 PluginManager 在 doctor 上下线时正确联动，需在 `package.json` 的 `aalis.service.optional` 里也写上 `'doctor'`，与代码里的 `export const inject` 保持双源一致（参考 [`plugin-storage-local/package.json`](../../packages/plugin-storage-local/package.json) 的 `aalis.service.optional: ['doctor']`）。dual-source 规则见 [manifest-metadata](../concepts/manifest-metadata.md)。

```jsonc
// package.json
{
  "dependencies": { "@aalis/plugin-doctor-api": "^0.5.0" },
  "aalis": { "service": { "optional": ["doctor"] } }
}
```

`useDoctorService` 内部用 `whenService` 持续订阅 `'doctor'`：doctor 每次上线都会重新挂 check，doctor 下线或本插件 dispose 时自动解注册（[`plugin-doctor-api/src/index.ts:101-104`](../../packages/plugin-doctor-api/src/index.ts)，语义见 [`context.ts:336-343`](../../packages/core/src/context.ts)）。所以即使 doctor 比你晚加载，也不会漏注册。

### 命名约定

- `id` 用 `领域.子项` 点分前缀（`storage.roots`、`env.node`、`plugins.errored`），避免与他人撞车。
- 同 `id` 重复注册以最后一次为准（[`plugin-doctor/src/index.ts:42-43`](../../packages/plugin-doctor/src/index.ts) 会打 debug 日志）。
- `category` 影响报告分组；没有合适分类用 `'other'`。

---

## 4. 自建一个 doctor provider（少见 — provider 角度）

`doctor` 是按 DI 名字解析的服务，理论上可被替换，但**绝大多数场景没必要**——它只是个聚合器，要扩展应该是「注册更多 check」而非「换聚合后端」。仅当你要彻底改报告形态（如接外部监控系统）时才考虑。

provider 必须实现完整的 `DoctorService` 四个方法。最小骨架：

```ts
import type { Context } from '@aalis/core';
import type { CheckResult, CheckSpec, DoctorReport, DoctorService } from '@aalis/plugin-doctor-api';

export const name = '@aalis/plugin-doctor-custom';
export const provides = ['doctor'];

class CustomDoctor implements DoctorService {
  private last?: DoctorReport;
  private readonly specs = new Map<string, CheckSpec>();
  constructor(private readonly ctx: Context) {}

  registerCheck(spec: CheckSpec): () => void {
    this.specs.set(spec.id, spec);                       // 同 id 覆盖
    return () => { if (this.specs.get(spec.id) === spec) this.specs.delete(spec.id); };
  }
  getLastReport(): DoctorReport | undefined { return this.last; }
  listChecks() {
    return [...this.specs.values()].map(s => ({ id: s.id, category: s.category, pluginName: s.pluginName }));
  }
  async runChecks(): Promise<DoctorReport> {
    const checks: CheckResult[] = [];
    for (const spec of this.specs.values()) {
      try {
        const r = await spec.run(this.ctx);
        checks.push(...(Array.isArray(r) ? r : [r]));
      } catch (err) {
        // 必须吞掉单条异常，否则一个坏 check 拖垮整份报告
        checks.push({ id: spec.id, category: spec.category, level: 'error',
          message: `检查项 ${spec.id} 抛出异常`, detail: err instanceof Error ? err.message : String(err) });
      }
    }
    const summary = checks.reduce((a, c) => (a[c.level]++, a), { ok: 0, warn: 0, error: 0 });
    this.last = { generatedAt: new Date().toISOString(), summary, checks };
    this.ctx.emit('doctor:updated', { generatedAt: this.last.generatedAt, summary }).catch(() => {});
    return this.last;
  }
}

export function apply(ctx: Context): void {
  ctx.provide('doctor', new CustomDoctor(ctx));
}
```

注册细节（[`plugin-doctor/src/index.ts:150-167`](../../packages/plugin-doctor/src/index.ts)，`provide` 签名 [`context.ts:185-188`](../../packages/core/src/context.ts)）：

- `ctx.provide('doctor', instance, options?)`，`options.priority` 默认 0（`ServicePriority.Backend`）。要抢占官方 doctor 用 `ServicePriority.Override`（50）或 `System`（200），从 `@aalis/core` 导入枚举（[`core/src/index.ts:34`](../../packages/core/src/index.ts)）；裸数字会触发 devMode 校验告警（[`service-helpers.ts:59-62`](../../packages/core/src/service-helpers.ts)）。
- 同名解析顺序：**preference > priority > 注册顺序**，无能力匹配（0.5.0 移除）。详见 [service-model](../concepts/service-model.md) 与 [docs/core/service.md](../core/service.md)。
- `provides` / `inject` 与 `package.json` 的 `aalis.service.provides` 双源都要写 `'doctor'`。
- 实现里**务必** per-check `try/catch`（官方 doctor 在 [`index.ts:60-72`](../../packages/plugin-doctor/src/index.ts) 这么做），并在每次 `runChecks` 后发 `'doctor:updated'`，否则 WebUI 不会刷新。

---

## 5. 标准消费姿势：跑诊断 / 读结果

doctor 是可选服务，consumer 必须**每次现取、容错缺失**，不要缓存句柄（provider 弹跳会失效，见 [lazy-service-access](../concepts/lazy-service-access.md)）。

```ts
// 触发一次诊断（如 WebUI action）
const report = await ctx.getService<DoctorService>('doctor')?.runChecks();

// 读上次报告
const checks = ctx.getService<DoctorService>('doctor')?.getLastReport()?.checks ?? [];
```

官方 `actions`（[`plugin-doctor/src/index.ts:133-146`](../../packages/plugin-doctor/src/index.ts)）就是这个模式：`?.` 链式吞掉服务缺失，`?? []` 兜底空数组。订阅式 consumer 监听事件即可（[`plugin-webui-server/src/index.ts:1183`](../../packages/plugin-webui-server/src/index.ts)）：

```ts
import type {} from '@aalis/plugin-doctor-api';   // 仅引入事件类型增强
ctx.on('doctor:updated', () => refresh());
```

报告的两个入口：聊天 / CLU 走 `/doctor` 命令（[`plugin-doctor/src/index.ts:161-166`](../../packages/plugin-doctor/src/index.ts)，输出经 `formatReport` 按 level 分组排版 [`index.ts:249-280`](../../packages/plugin-doctor/src/index.ts)）；WebUI 走 doctor 页面的 `runChecks` / `getReport` / `getLastRunAt` actions（[`index.ts:98-146`](../../packages/plugin-doctor/src/index.ts)）。

---

## 6. 能力 / 风险 → 影响

- **检查项不是隔离沙箱。** `run(ctx)` 拿到的是插件自身的 `Context`，能力 = 你这个插件能做的一切。doctor 不会替你降权。`runChecks` 由 `/doctor` 命令或 WebUI 触发，本质是「以触发者身份跑一遍所有已注册探测」——别在 `run` 里做带副作用 / 危险操作，它应当是**只读探测**。storage 的 `storage.roots` 检查只是写一个临时探针文件随即删除（[`plugin-storage-local/src/index.ts:717-735`](../../packages/plugin-storage-local/src/index.ts)），这是探测可写性的克制做法。
- **异常被聚合器吞成 error 级结果**，不会向上抛（[`plugin-doctor/src/index.ts:64-72`](../../packages/plugin-doctor/src/index.ts)）。所以 `run` 抛错只会让该项显示为 error，不会中断别的检查；但也别依赖抛错传递信息，正常路径应返回带 `level` 的 `CheckResult`。
- **`detail` 会出现在报告 / WebUI 表格 / 聊天输出里。** 不要把密钥、完整路径外的敏感信息塞进 `detail`——它在单 owner 本地场景下默认对 owner 可见，但仍应遵循脱敏惯例（参考 [security-model](../concepts/security-model.md)）。
- 涉及网络探测的检查项，出口请走 `safeFetch`（`@aalis/util-network-guard`）而非裸 `fetch`，避免把诊断端点变成 SSRF 跳板（见 [security-model](../concepts/security-model.md)）。

---

## 7. 边界与坑

- **没有内置定时 / 自动跑。** doctor 不自调度——只在 `/doctor` 命令、WebUI「立即运行」按钮、或你显式调 `runChecks()` 时才跑。需要周期体检得自己接 scheduler。
- **`getLastReport()` 在从未运行时返回 `undefined`，不是空报告。** consumer 必须判空（官方 `getLastRunAt` 返回「尚未运行」[`index.ts:142-143`](../../packages/plugin-doctor/src/index.ts)）。
- **同 `id` 静默覆盖。** 两个插件用同一 `id` 注册，后者赢、前者被踢，仅打 debug 日志（[`plugin-doctor/src/index.ts:42-43`](../../packages/plugin-doctor/src/index.ts)）。务必用领域前缀避免撞车。
- **`run` 无超时保护。** `runChecks` 顺序 `await` 每个 spec（[`index.ts:59-63`](../../packages/plugin-doctor/src/index.ts)），一个慢检查会拖慢整份报告，也没有取消机制。`run` 内部该自带超时 / `AbortController`。
- **报告 = 一次性快照**，存在 `last` 字段里，新一次 `runChecks` 整体替换；没有历史留存。需要趋势 / 历史得自己在 `doctor:updated` 订阅里落库。
- **不要在 `apply` 里同步调 `getService('doctor')` 注册 check。** doctor 可能尚未加载——这正是 `useDoctorService`（基于 `whenService`）存在的理由。直接 `getService` 会在加载顺序不利时静默漏注册。

---

## 8. 交叉链接

- 概念：[service-model](../concepts/service-model.md)（DI 按名解析 / 优先级）、[lazy-service-access](../concepts/lazy-service-access.md)（每用现取、`whenService`）、[manifest-metadata](../concepts/manifest-metadata.md)（`provides`/`inject` 双源）、[security-model](../concepts/security-model.md)（safeFetch / 脱敏）。
- 核心：[docs/core/service.md](../core/service.md)、[docs/core/context.md](../core/context.md)（`provide` / `whenService` / `on` / `emit`）、[docs/core/commands.md](../core/commands.md)（`/doctor` 入口）。
- 同类服务文档（注册中心模式）：[services/tools.md](./tools.md)、[services/commands.md](./commands.md)、[services/storage.md](./storage.md)（`storage.roots` 检查的提供方）。
