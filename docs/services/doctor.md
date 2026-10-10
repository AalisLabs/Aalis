# doctor 服务 — 自检诊断注册中心

> 面向：要给 Aalis 贡献一条健康检查项（最常见，consumer 角度），或要替换 / 自建诊断聚合后端（provider 角度）的第三方作者。

`doctor` 是一个开放注册中心：各业务插件把「自己领域是否健康」的探测逻辑注册进来，doctor 负责聚合、跑全套、出报告。它在 DI 容器里的注册名是字符串 `'doctor'`（消费方经 `doctor.use` 调用），契约包是 `@aalis/api-doctor`。

为什么单独抽出 `-api` 包。如果 storage、commands 等下游插件必须直接 runtime depend 实现包 `plugin-doctor` 才能注册检查项，就会形成「实现包 ↔ 业务插件」的双向耦合。doctor 仿照 storage-api、commands-api 的做法，把类型和一个 `doctor.use.registerCheck` helper 抽到 `-api`，业务插件只依赖契约，doctor 自身不反向硬依赖任何业务插件。

参考实现是 `@aalis/plugin-doctor`，它是唯一的 provider，内置 `env.node`、`env.platform`、`plugins.status`、`services.preferences` 四条与领域无关的检查。典型 consumer 是注册检查项的插件，例如 `@aalis/plugin-storage-local` 注册 `storage.roots` 探测可写性。

---

## 1. 契约：类型与服务接口

契约类型全部定义在 `@aalis/api-doctor`。

### 检查结果与报告

```ts
export type CheckLevel = 'ok' | 'warn' | 'error';
export type CheckCategory = 'env' | 'filesystem' | 'plugins' | 'config' | 'service' | 'other';

export interface CheckResult {
  id: string;            // 结果 id，可与 spec.id 不同（一个 spec 可产出多条带不同 id 的结果）
  category: CheckCategory;
  level: CheckLevel;
  message: string;       // 一行结论：出了什么事
  detail?: string;       // 多行详情，\n 分隔；warn 与 error 在这里写怎么修
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
  pluginName?: string;   // 来源插件名；doctor.use.registerCheck 会自动注入 lifecycle.use.id
  run(): Promise<CheckResult | CheckResult[]> | CheckResult | CheckResult[]; // 用到的能力由注册方闭包带入
}
```

`warn` 与 `error` 的结果写两件事：`message` 写出了什么事，`detail` 写用户该做什么，具体到配置项、命令或页面，例如「在模型服务里加一个能看图的模型，再到识图插件的「识别模型」里选它」；原因（下层的报错原文）可以跟在修法前后，但不能只有原因。指向文档时写文档站上的完整地址，不写仓库路径。诊断是用户自查的入口，没装 WebUI 的用户只能靠 `/doctor` 看到这些（见[作者指南「报错与故障说明」](../plugin-author-guide.md#_9-5-报错与故障说明)）。

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

这条事件在每次 `runChecks()` 完成后发射，供订阅者得知报告换了（官方诊断页不靠它：页面属于 doctor 插件自己，运行完直接重取）。如果某个包只想拿到这条事件类型、并不调用服务，只需 `import type {} from '@aalis/api-doctor'` 触发声明合并即可。

### Helper `doctor.use.registerCheck`

这是 consumer 注册检查项的推荐入口，它封装了 doctor 尚未就绪时的延迟注册：

```ts
export interface BoundDoctor extends DoctorService {
  registerCheck(spec: CheckSpec): () => void;
}
```

`doctor.use.registerCheck` 走 `registrar`：同 id 替换、提供者换人自动重挂、随激活撤回，并自动把 `pluginName` 填成这次激活 id。

### 缺与在等的共享判据 `unmetDependencies`

插件停在 pending，是它有 required 服务此刻没有提供者。`unmetDependencies` 把每个这样的服务沿声明提供它的已装插件往下追，直到一个不是 pending 的插件或追不下去的地方，那里就是根。runtime 的启动告警、plugin-doctor 的 `plugins.pending`、WebUI 的插件列表与「需要处理」、终端界面的欢迎行与市场的卸载闸都调它，几处的判断与说法因此一致。

```ts
/** 判据读的插件状态：core 插件状态快照（PluginStatusEntry）里的这几项 */
type PluginSnapshot = Pick<PluginStatusEntry, 'instanceId' | 'state' | 'provides' | 'uses' | 'error' | 'lingering'>;

type UnmetRoot =
  | { kind: 'error'; instance: string; error?: string } // 根插件激活失败，带它的失败说明
  | { kind: 'disabled'; instance: string } // 根插件已停用
  | { kind: 'starting'; instance: string } // 根插件在启动：只是在等
  | { kind: 'lingering'; instance: string } // 根插件要的都在了，在等自己的旧实例停下：只是在等
  | { kind: 'withdrawn'; instance: string; service: string } // 根插件在运行，却没在提供 service（激活后自己撤回了）
  | { kind: 'unprovided'; service: string } // 没有已装的插件声明提供它
  | { kind: 'cycle'; instances: string[] }; // 几个插件互相等待成环

interface UnmetService {
  service: string;
  chain: string[]; // 从直接提供者往下、一路没起来的插件实例；根是插件时最后一个就是它
  root: UnmetRoot;
}

interface UnmetDependencies {
  lacking: UnmetService[]; // 缺：根失败、停用、在运行却没在提供、没有提供者或成环，要人处理
  waiting: UnmetService[]; // 在等：根在启动，它启动完就满足
}

/** 每个 pending 插件没满足的 required 服务，按实例 id；available 是当前有提供者的服务名（services.use.names()） */
function unmetDependencies(plugins: readonly PluginSnapshot[], available: Iterable<string>): Map<string, UnmetDependencies>;
/** 写成一句（启动告警、诊断与回执用） */
function describeUnmet(unmet: UnmetDependencies): string;
```

- 只收普通数据：插件状态快照与当前有提供者的服务名。required 与 optional 按快照里 `uses` 每项的 `kind` 分。
- 判缺看服务名，不看谁声明提供：宿主在根上提供的服务（`host-config`、`host-paths` 等）不在任何插件的 `provides` 里，照样不算缺。声明提供它的已装插件（卸载在途的除外）只用来往下追根。
- 提供者自己的状态：失败、停用就是根；在激活（含转入后台的慢激活）是「在启动」；在运行却没在提供这个服务（激活之后自己撤回了，例如模型全被删掉的模型插件）也是根，它不会自己补上，算缺；pending 的接着往下追它自己没满足的服务，它缺一样就是缺，只是在等就是在等，什么都不缺（马上激活）也算在启动；什么都不缺、却在等自己的旧实例停下（状态快照的 `lingering`）的是「在等旧实例停下」。追回已经走过的插件就是成环。
- 一个服务有几个已装的提供者：有一个只是在等，这个服务就是在等（它启动完就有）；都不是时每个提供者各一条，各写到自己的根。
- `describeUnmet` 的写法：缺的逐条写「缺少服务 <服务>（<链> 失败：<说明> / 已停用 / 在运行但没有提供 <服务> / → 没有已装的插件提供 <服务> / 互相等待成环：<插件>）」，没有链时写「缺少服务 <服务>（没有已装的插件提供）」；在等的写「等待 <实例> 启动」或「等待 <实例> 的旧实例停下」，同一句只写一次；各条用「；」连起来。

---

## 2. 谁提供 / 谁消费

| 角色 | 包 | 关键点 |
| --- | --- | --- |
| Provider（唯一） | `@aalis/plugin-doctor` | `provide.use(doctor, registry)`；内置 `env.node` / `env.platform` / `plugins.status` / `services.preferences`；挂 `/doctor` 命令与 WebUI 页面 |
| Consumer（注册检查项） | `@aalis/plugin-storage-local` | `doctor.use.registerCheck({ id: 'storage.roots', ... })` |
| Consumer（注册检查项） | `@aalis/runtime`（宿主，经根绑定） | `config.secrets`：配置里引用的密钥不在 `secrets.yaml` 里时，每个这样的实例报一条 error（id `config.secrets.<实例 id>`，点名字段与键），都在时报一条 ok。不走 `parseConfig` 的插件拿到悬空引用不会激活失败，靠这一项发现 |

内置检查项与第三方检查项走的是同一条 `registerCheck` 路径，在 `listChecks()` 和报告里一视同仁，第三方贡献者并非二等公民。

`plugins.status` 在插件管理服务在场时产出四条结果，有在等的插件、有旧实例没停下的插件时各另加一条：`plugins.active`、`plugins.errored`（逐个附错误说明：激活失败原因，或初始化期间 required 依赖反复缺失时「自动重试未收敛，已停止」，后者依赖恢复后不自动重试，需 `enable` 或 `bounce`）、`plugins.pending`（未就绪：缺服务的实例，每个一行「<实例>: <describeUnmet 的一句>」，缺的沿依赖链追到根；有则 warn；为此 plugin-doctor 在 `uses` 里声明了 core 的 `services`，取 `services.use.names()`）、`plugins.slow`（逐个列出激活超过 core 慢操作阈值 `slowThresholdMs`、仍在后台进行的实例，即 `getStatus()` 里 `slow: true` 的条目，最后一行写怎么办；有则 warn），`plugins.waiting`（只在等别的插件启动的实例，写法同 `plugins.pending`；ok，没有在等的插件时不出这一条），以及 `plugins.lingering`（旧实例超过宽限仍未停下的实例，即 `getStatus()` 里 `lingering: true` 的条目，每个一行「等待 <实例> 的旧实例停下」，与依赖链上 `lingering` 根的说法相同，最后一行写怎么办；warn，没有时不出这一条）。判据是上文的 `unmetDependencies`，与 runtime 的启动告警、WebUI 的「需要处理」相同：后台激活的插件提供的服务在它完成前不对外，依赖它的插件只是在等，不算未就绪。

`services.preferences`（服务偏好未生效）逐个看配置文档里的服务偏好（`hostConfig.getServicePreferences()`，为此 plugin-doctor 以 optional 声明 `host-config`）：全局偏好之外，`pluginServicePreferences` 里各插件的本插件偏好也一并查（`getServicePreferences({ for })`）。偏好指向的提供者不在这个服务此刻的提供者里（`services.use.inspect(name, { for })`；例如偏好的模型删了、提供它的插件停用了），这个服务就落到了别的提供者上。每个这样的偏好报一条 warn（全局偏好 id `services.preferences.<服务名>`，本插件偏好 id `services.preferences.<插件实例 id>.<服务名>`，消息点名是哪个插件的），`detail` 第一行写实际在用哪个（按偏好所在口径的解析顺序排第一的那个；没有提供者时写没有），第二行写怎么改：本插件偏好指向 WebUI 插件详情的服务偏好或配置文件的 `pluginServicePreferences`；全局偏好里 llm 指向 WebUI 设置「会话默认」全局默认层的「模型」（默认模型只此一处，系统页不单列它），其余服务指向配置文件的 `servicePreferences` 或 WebUI 设置「系统」的服务偏好。不只查 llm，哪个服务的偏好悬空都报；偏好都在生效时报一条 ok。宿主没有提供配置文档时没有可查的偏好，同样报 ok。

---

## 3. 贡献一条检查项（最常见用法 — consumer）

绝大多数第三方需求是「我的插件想上报自己领域是否健康」，而不是替换 doctor。这种情况直接用 helper 即可。

### 最小骨架

```ts
import { doctor } from '@aalis/api-doctor';
import { definePlugin, optional } from '@aalis/core';

export default definePlugin({
  name: '@aalis/plugin-my-feature',
  uses: { doctor: optional(doctor) },
  apply({ doctor }) {
    doctor.use.registerCheck({
      id: 'my-feature.connectivity',
      category: 'service',
      async run() {
        return {
          id: 'my-feature.connectivity',
          category: 'service',
          level: 'ok',
          message: '后端连通',
        };
      },
    });
  },
});
```

### 必须同步两处清单元数据

运行时联动完全由代码里的 `uses` 决定。`package.json` 的 `aalis.service.optional` 也要写上 `'doctor'`：它供市场做装前披露，须与 `uses` 保持一致（第一方由 manifest-parity 测试守），不影响运行时联动。双源规则见 [manifest-metadata](../concepts/manifest-metadata.md)。

```jsonc
// package.json
{
  "dependencies": { "@aalis/api-doctor": "^0.5.0" },
  "aalis": { "service": { "optional": ["doctor"] } }
}
```

`doctor.use.registerCheck` 经资源口的 `registrar` 登记：doctor 不在时先记下，上线时挂上；doctor 换人时整体重挂到新的那一家；本插件关闭时与原语同一拍撤回。因此即使 doctor 比你晚加载，也不会漏注册。doctor 在场时它拒收的登记原样抛给调用方。

### 命名约定

- `id` 用「领域.子项」点分前缀（`storage.roots`、`env.node`、`plugins.errored`），避免与他人撞车。
- 同 `id` 重复注册以最后一次为准。同一激活再登记是替换（先撤回自己原来那条）；别的激活已登记同一 `id` 时，doctor 覆盖它并打一条 debug 日志。
- `category` 影响报告分组；没有合适分类时用 `'other'`。

---

## 4. 自建一个 doctor provider（少见 — provider 角度）

`doctor` 是按 DI 名字解析的服务，理论上可被替换，但绝大多数场景没有必要。它只是个聚合器，扩展它的正确方式是「注册更多 check」而非「更换聚合后端」。只有当你要彻底改变报告形态（例如对接外部监控系统）时，才需要考虑自建 provider。

provider 必须实现完整的 `DoctorService` 四个方法。最小骨架：

```ts
import { doctor } from '@aalis/api-doctor';
import type { CheckResult, CheckSpec, DoctorReport, DoctorService } from '@aalis/api-doctor';
import { definePlugin, events, provide } from '@aalis/core';

class CustomDoctor implements DoctorService {
  private last?: DoctorReport;
  private readonly specs = new Map<string, CheckSpec>();

  registerCheck(spec: CheckSpec): () => void {
    this.specs.set(spec.id, spec);
    return () => {
      if (this.specs.get(spec.id) === spec) this.specs.delete(spec.id);
    };
  }
  getLastReport(): DoctorReport | undefined {
    return this.last;
  }
  listChecks() {
    return [...this.specs.values()].map(s => ({
      id: s.id,
      category: s.category,
      pluginName: s.pluginName,
    }));
  }
  async runChecks(): Promise<DoctorReport> {
    const checks: CheckResult[] = [];
    for (const spec of this.specs.values()) {
      try {
        const r = await spec.run();
        checks.push(...(Array.isArray(r) ? r : [r]));
      } catch (err) {
        checks.push({
          id: spec.id,
          category: spec.category,
          level: 'error',
          message: `检查项 ${spec.id} 抛出异常`,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const summary = checks.reduce(
      (a, c) => {
        a[c.level]++;
        return a;
      },
      { ok: 0, warn: 0, error: 0 },
    );
    this.last = { generatedAt: new Date().toISOString(), summary, checks };
    return this.last;
  }
}

export default definePlugin({
  name: '@aalis/plugin-doctor-custom',
  provides: [doctor],
  uses: { provide, events },
  apply({ provide, events }) {
    const impl = new CustomDoctor();
    provide.use(doctor, impl);
    void events;
  },
});
```

关于注册，有几点需要注意：

- `provide.use(doctor, instance, options?)` 的 `options.priority` 默认为 0。要抢占官方 doctor，设更高的 priority（数字越大越优先）。
- 同名时消费方选中哪一家按本插件偏好 > 全局偏好 > priority > 注册顺序，不再有能力匹配（0.5.0 已移除）。详见 [service-model](../concepts/service-model.md) 与 [docs/core/service.md](../core/service.md)。
- `provides` / `uses` 与 `package.json` 的 `aalis.service.provides` 双源都要写上 `'doctor'`。
- 实现里务必对每条 check 做 try/catch（官方 doctor 就是这么做的），并在每次 `runChecks` 之后发出 `'doctor:updated'`，订阅结果的 consumer 靠它得知报告换了。

---

## 5. 标准消费方式：跑诊断 / 读结果

doctor 是可选服务，consumer 先看 `present` 再调用、并对缺失容错。业务句柄 `doctor.use` 是活的：每次访问成员都解析到本插件当前选中的那一家，provider 弹跳后存起来的句柄也会跟着换，原理见 [lazy-service-access](../concepts/lazy-service-access.md)。

```ts
// 触发一次诊断（如 WebUI action）
const report = doctor.present ? await doctor.use.runChecks() : undefined;

// 读上次报告
const checks = (doctor.present ? doctor.use.getLastReport()?.checks : undefined) ?? [];
```

第三方 consumer 用这个模式：先看 `present` 处理服务缺失，`?? []` 兜底空数组。官方诊断页的数据源与动作则直接闭包本次激活的 registry，不经 `doctor.use` 去找选中的提供者。订阅式 consumer 监听事件即可：

```ts
import type {} from '@aalis/api-doctor';   // 仅引入事件类型增强
events.use.on('doctor:updated', () => refresh());
```

报告有两个入口。聊天 / CLI 走 `/doctor` 命令（受限指令，需要等级 2，见第 6 节），输出经 `formatReport` 按 level 分组排版；WebUI 走插件详情里的诊断页（`key: 'doctor'`）：「立即运行」、上次运行的时间与通过、警告、错误数，以及结果表（级别、类别、检查项、说明、详情）。

每次运行之后（不论从命令、诊断页还是别的插件触发），诊断页重取；结果里有错误或警告时发一条提示（有错误时是「出错」，只有警告时是「需要处理」），标题写明几项（如「诊断有 1 项错误、2 项警告」），跳到诊断页；全部通过后撤回。

---

## 6. 能力 / 风险 → 影响

::: warning 检查项不是隔离沙箱
`run` 在注册方的闭包里执行，能力等于注册插件所能做的一切，doctor 不会替你降权。`runChecks` 由 `/doctor` 命令或 WebUI 触发，本质是「以触发者身份跑一遍所有已注册探测」。因此不要在 `run` 里做带副作用或危险的操作，它应当是只读探测。storage 的 `storage.roots` 检查只写一个临时探针文件、随即删除，这是探测可写性的克制做法。
:::

- `/doctor` 是受限指令（`visibility: 'restricted'`）：需要等级 2，不需要确认；owner 不受等级限制（本机 CLI 与 WebUI 的 `console` 身份即 owner）。未装或未启用 `@aalis/plugin-authority` 时指令没有执行守卫，受限指令一律被拒，`/doctor` 对 owner 也不可用，WebUI 的诊断页不受影响。报告里有存储根的宿主路径和插件的报错原文，报错原文里可能有内网地址与端口，因此默认等级（0）的用户不能运行。门槛可在 WebUI 设置里的权限页按能力键 `command:doctor` 调整（配置项 `authorityOverrides`，见 [plugin-authority](../plugins/plugin-authority.md)）：只让 owner 使用时，调到比任何已授予的等级都高的整数，如 99；要让某些用户使用，给他们等级 2，或调低门槛。
- 异常会被聚合器吞成 error 级结果，不向上抛出。`run` 抛错只会让该项显示为 error，不会中断其他检查；但不要依赖抛错来传递信息，正常路径应返回带 `level` 的 `CheckResult`。
- `detail` 会出现在报告、WebUI 表格和聊天输出里。不要把密钥、完整路径这类敏感信息写进 `detail`。`/doctor` 只对等级 2 及以上的用户与 owner 开放（见本节第一条），但仍应遵循脱敏惯例，参考 [security-model](../concepts/security-model.md)。
- 涉及网络探测的检查项，出口请走 `safeFetch`（`@aalis/util-network-guard`）而非裸 `fetch`，避免把诊断端点变成 SSRF 跳板，见 [security-model](../concepts/security-model.md)。

---

## 7. 边界与注意事项

- 没有内置定时 / 自动运行。doctor 不自调度，只在 `/doctor` 命令、WebUI 的「立即运行」按钮、或你显式调用 `runChecks()` 时才跑。需要周期体检得自己接 scheduler。
- `getLastReport()` 在从未运行时返回 `undefined`，而不是空报告，consumer 必须判空。官方诊断页在这种情况下写「尚未运行」。
- 同 `id` 静默覆盖。两个插件用同一 `id` 注册时后者赢、前者被踢，仅打一条 debug 日志。务必用领域前缀避免撞车。
- `run` 没有超时保护。`runChecks` 会顺序 `await` 每个 spec，一个慢检查会拖慢整份报告，也没有取消机制。你应当在 `run` 内部自带超时或 `AbortController`。
- 报告是一次性快照，存放在 `last` 字段里，新一次 `runChecks` 会整体替换它，没有历史留存。需要趋势或历史，得自己在 `doctor:updated` 订阅里落库。
- 不要在 `apply` 里经 `services.use.get(doctor)` 拿原始实例来注册 check。doctor 可能尚未加载——这正是 `doctor.use.registerCheck` 存在的理由：提供者未就绪时记在账上、就绪后挂上。直接调原始实例会在加载顺序不利时静默漏注册，也不随提供者换人重挂。

---

## 8. 交叉链接

- 概念：[service-model](../concepts/service-model.md)（DI 按名解析 / 优先级）、[lazy-service-access](../concepts/lazy-service-access.md)（业务句柄是活的、`follow`）、[manifest-metadata](../concepts/manifest-metadata.md)（`provides`/`uses` 双源）、[security-model](../concepts/security-model.md)（safeFetch / 脱敏）。
- 核心：[docs/core/service.md](../core/service.md)、[docs/core/context.md](../core/context.md)（`provide` / `follow` / `on` / `emit`）、[docs/plugins/plugin-commands.md](../plugins/plugin-commands.md)（`/doctor` 入口）。
- 同类服务文档（注册中心模式）：[services/tools.md](./tools.md)、[services/commands.md](./commands.md)、[services/storage.md](./storage.md)（`storage.roots` 检查的提供方）。
