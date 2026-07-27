# doctor 服务 — 自检诊断注册中心

> 面向：要给 Aalis 贡献一条健康检查项（最常见，consumer 角度），或要替换 / 自建诊断聚合后端（provider 角度）的第三方作者。

`doctor` 是一个开放注册中心：各业务插件把「自己领域是否健康」的探测逻辑注册进来，doctor 负责聚合、跑全套、出报告。它在 DI 容器里的注册名是字符串 `'doctor'`（`ctx.getService('doctor')`），契约包是 `@aalis/plugin-doctor-api`。

为什么单独抽出 `-api` 包。如果 storage、commands 等下游插件必须直接 runtime depend 实现包 `plugin-doctor` 才能注册检查项，就会形成「实现包 ↔ 业务插件」的双向耦合。doctor 仿照 storage-api、commands-api 的做法，把类型和一个 `useDoctorService` helper 抽到 `-api`，业务插件只依赖契约，doctor 自身不反向硬依赖任何业务插件。

参考实现是 `@aalis/plugin-doctor`，它是唯一的 provider，内置 `env.node`、`env.platform`、`plugins.status` 三条与领域无关的检查。典型 consumer 有两类：`@aalis/plugin-storage-local` 注册 `storage.roots` 探测可写性；`@aalis/plugin-webui-server` 订阅 `doctor:updated` 事件刷新 WebUI。

---

## 1. 契约：类型与服务接口

契约类型全部定义在 `@aalis/plugin-doctor-api`。

### 检查结果与报告

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

### 检查项定义 `CheckSpec`

```ts
export interface CheckSpec {
  id: string;            // 唯一 id，如 'memory.connectivity'；重复注册以最后一次为准
  category: CheckCategory;
  label?: string;        // 仅用于日志/调试显示
  pluginName?: string;   // 来源插件名；useDoctorService 会自动注入 ctx.id
  run(ctx: Context): Promise<CheckResult | CheckResult[]> | CheckResult | CheckResult[];
}
```

`run` 可以同步或异步返回，也可以返回单条或多条 `CheckResult`。一个 spec 通常对应一个领域（如 `storage.roots`），但允许为每个被探测对象各产出一条结果——例如 storage-local 会为每个可写 root 产一条。

### 服务接口 `DoctorService`

```ts
export interface DoctorService {
  runChecks(): Promise<DoctorReport>;                 // 跑全部检查，写入 last，发 'doctor:updated'
  getLastReport(): DoctorReport | undefined;          // 取上次报告；从未运行过为 undefined
  registerCheck(spec: CheckSpec): () => void;         // 注册；返回 dispose；同 id 覆盖
  listChecks(): Array<{ id: string; category: CheckCategory; pluginName?: string }>;
}
```

### 事件增强

`-api` 用 declaration merging 给 `@aalis/core` 的 `AalisEvents` 增加了一条事件类型：

```ts
'doctor:updated': [info: { generatedAt: string; summary: { ok: number; warn: number; error: number } }];
```

这条事件在每次 `runChecks()` 完成后发射，供 WebUI 等订阅者即时刷新。如果某个包只想拿到这条事件类型、并不调用服务，只需 `import type {} from '@aalis/plugin-doctor-api'` 触发声明合并即可。

### Helper `useDoctorService`

这是 consumer 注册检查项的推荐入口，它封装了 doctor 尚未就绪时的延迟注册：

```ts
export interface ScopedDoctorService {
  registerCheck(spec: CheckSpec): () => void;  // 立即或延迟注册；返回 dispose
}
export function useDoctorService(ctx: Context): ScopedDoctorService;
```

内部实现基于 `ctx.whenService<DoctorService>('doctor', svc => svc.registerCheck(filledSpec))`，并自动把 `pluginName` 填成 `ctx.id`。

---

## 2. 谁提供 / 谁消费

| 角色 | 包 | 关键点 |
| --- | --- | --- |
| Provider（唯一） | `@aalis/plugin-doctor` | `ctx.provide('doctor', registry)`；内置 `env.node` / `env.platform` / `plugins.status`；挂 `/doctor` 命令与 WebUI 页面 |
| Consumer（注册检查项） | `@aalis/plugin-storage-local` | `useDoctorService(ctx).registerCheck({ id: 'storage.roots', ... })` |
| Consumer（订阅结果） | `@aalis/plugin-webui-server` | `ctx.on('doctor:updated', () => broadcastPageRefresh(...))` |

内置检查项与第三方检查项走的是同一条 `registerCheck` 路径，在 `listChecks()` 和报告里一视同仁，第三方贡献者并非二等公民。

---

## 3. 贡献一条检查项（最常见用法 — consumer）

绝大多数第三方需求是「我的插件想上报自己领域是否健康」，而不是替换 doctor。这种情况直接用 helper 即可。

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

doctor 作为可选依赖，要让 PluginManager 在 doctor 上下线时正确联动，你需要在 `package.json` 的 `aalis.service.optional` 里也写上 `'doctor'`，与代码里的 `export const inject` 保持双源一致。双源规则见 [manifest-metadata](../concepts/manifest-metadata.md)。

::: warning
两处清单必须同时写。只在代码里声明 `inject.optional` 而漏了 `package.json` 的 `aalis.service.optional`（或反之），PluginManager 在 doctor 上下线时的联动就会失效，且不会给出显式报错。
:::

```jsonc
// package.json
{
  "dependencies": { "@aalis/plugin-doctor-api": "^0.5.0" },
  "aalis": { "service": { "optional": ["doctor"] } }
}
```

`useDoctorService` 内部用 `whenService` 持续订阅 `'doctor'`：doctor 每次上线都会重新挂载 check，doctor 下线或本插件 dispose 时自动解注册。因此即使 doctor 比你晚加载，也不会漏注册。

### 命名约定

- `id` 用「领域.子项」点分前缀（`storage.roots`、`env.node`、`plugins.errored`），避免与他人撞车。
- 同 `id` 重复注册以最后一次为准，覆盖时会打一条 debug 日志。
- `category` 影响报告分组；没有合适分类时用 `'other'`。

---

## 4. 自建一个 doctor provider（少见 — provider 角度）

`doctor` 是按 DI 名字解析的服务，理论上可被替换，但绝大多数场景没有必要。它只是个聚合器，扩展它的正确方式是「注册更多 check」而非「更换聚合后端」。只有当你要彻底改变报告形态（例如对接外部监控系统）时，才需要考虑自建 provider。

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

关于注册，有几点需要注意：

- `ctx.provide('doctor', instance, options?)` 的 `options.priority` 默认为 0（`ServicePriority.Backend`）。要抢占官方 doctor，使用 `ServicePriority.Override`（50）或 `System`（200），并从 `@aalis/core` 导入这些枚举；传裸数字会触发 devMode 校验告警。
- 同名解析顺序是 preference > priority > 注册顺序，不再有能力匹配（0.5.0 已移除）。详见 [service-model](../concepts/service-model.md) 与 [docs/core/service.md](../core/service.md)。
- `provides` / `inject` 与 `package.json` 的 `aalis.service.provides` 双源都要写上 `'doctor'`。
- 实现里务必对每条 check 做 try/catch（官方 doctor 就是这么做的），并在每次 `runChecks` 之后发出 `'doctor:updated'`，否则 WebUI 不会刷新。

---

## 5. 标准消费方式：跑诊断 / 读结果

doctor 是可选服务，consumer 必须每次现取、并对缺失容错，不要缓存服务句柄——provider 弹跳后旧句柄会失效，原理见 [lazy-service-access](../concepts/lazy-service-access.md)。

```ts
// 触发一次诊断（如 WebUI action）
const report = await ctx.getService<DoctorService>('doctor')?.runChecks();

// 读上次报告
const checks = ctx.getService<DoctorService>('doctor')?.getLastReport()?.checks ?? [];
```

官方 doctor 页面的 `actions` 就是这个模式：`?.` 链式吞掉服务缺失，`?? []` 兜底空数组。订阅式 consumer 监听事件即可：

```ts
import type {} from '@aalis/plugin-doctor-api';   // 仅引入事件类型增强
ctx.on('doctor:updated', () => refresh());
```

报告有两个入口。聊天 / CLU 走 `/doctor` 命令，输出经 `formatReport` 按 level 分组排版；WebUI 走 doctor 页面的 `runChecks` / `getReport` / `getLastRunAt` 三个 action。

---

## 6. 能力 / 风险 → 影响

::: warning 检查项不是隔离沙箱
`run(ctx)` 拿到的是插件自身的 `Context`，其能力等于你这个插件能做的一切，doctor 不会替你降权。`runChecks` 由 `/doctor` 命令或 WebUI 触发，本质是「以触发者身份跑一遍所有已注册探测」。因此不要在 `run` 里做带副作用或危险的操作，它应当是只读探测。storage 的 `storage.roots` 检查只写一个临时探针文件、随即删除，这是探测可写性的克制做法。
:::

- 异常会被聚合器吞成 error 级结果，不向上抛出。`run` 抛错只会让该项显示为 error，不会中断其他检查；但不要依赖抛错来传递信息，正常路径应返回带 `level` 的 `CheckResult`。
- `detail` 会出现在报告、WebUI 表格和聊天输出里。不要把密钥、完整路径这类敏感信息写进 `detail`。它在单 owner 本地场景下默认对 owner 可见，但仍应遵循脱敏惯例，参考 [security-model](../concepts/security-model.md)。
- 涉及网络探测的检查项，出口请走 `safeFetch`（`@aalis/util-network-guard`）而非裸 `fetch`，避免把诊断端点变成 SSRF 跳板，见 [security-model](../concepts/security-model.md)。

---

## 7. 边界与注意事项

- 没有内置定时 / 自动运行。doctor 不自调度，只在 `/doctor` 命令、WebUI 的「立即运行」按钮、或你显式调用 `runChecks()` 时才跑。需要周期体检得自己接 scheduler。
- `getLastReport()` 在从未运行时返回 `undefined`，而不是空报告，consumer 必须判空。官方 `getLastRunAt` 在这种情况下返回「尚未运行」。
- 同 `id` 静默覆盖。两个插件用同一 `id` 注册时后者赢、前者被踢，仅打一条 debug 日志。务必用领域前缀避免撞车。
- `run` 没有超时保护。`runChecks` 会顺序 `await` 每个 spec，一个慢检查会拖慢整份报告，也没有取消机制。你应当在 `run` 内部自带超时或 `AbortController`。
- 报告是一次性快照，存放在 `last` 字段里，新一次 `runChecks` 会整体替换它，没有历史留存。需要趋势或历史，得自己在 `doctor:updated` 订阅里落库。
- 不要在 `apply` 里同步调用 `getService('doctor')` 来注册 check。doctor 可能尚未加载——这正是基于 `whenService` 的 `useDoctorService` 存在的理由。直接 `getService` 会在加载顺序不利时静默漏注册。

---

## 8. 交叉链接

- 概念：[service-model](../concepts/service-model.md)（DI 按名解析 / 优先级）、[lazy-service-access](../concepts/lazy-service-access.md)（每用现取、`whenService`）、[manifest-metadata](../concepts/manifest-metadata.md)（`provides`/`inject` 双源）、[security-model](../concepts/security-model.md)（safeFetch / 脱敏）。
- 核心：[docs/core/service.md](../core/service.md)、[docs/core/context.md](../core/context.md)（`provide` / `whenService` / `on` / `emit`）、[docs/core/commands.md](../core/commands.md)（`/doctor` 入口）。
- 同类服务文档（注册中心模式）：[services/tools.md](./tools.md)、[services/commands.md](./commands.md)、[services/storage.md](./storage.md)（`storage.roots` 检查的提供方）。
