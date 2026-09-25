# commands 服务

斜杠指令（`/command`）的注册与分发。第三方插件用它把斜杠命令挂进所有平台共享的入站管道。

- **服务注册名**：描述符 `commands`（`name: 'commands'`），绑定接口 `BoundCommands`。
- **契约包**：`@aalis/api-commands`（类型 + 按激活绑定的 `command` builder）。
- **参考实现**：`@aalis/plugin-commands`，核心类是 `CommandRegistry`。
- **内核视角文档**：`docs/plugins/plugin-commands.md`。

> 绝大多数插件作者只需要登记命令。登记一律走 `commands.command(...)`，详见第 4 节。第 3 节只为想替换整个指令引擎的高级作者准备。

---

## 1. 契约：CommandService 接口

```ts
export interface CommandService {
  prefix: string;
  command(name: string, description?: string, meta?: InternalCommandMeta): CommandBuilder;
  unregister(name: string, contextId?: string): void;
  execute(name: string, ctx: ExecutionInput): Promise<string | undefined>;
  parseCommand(input: string): { name: string; args: string[]; raw: string } | null;
  hasMatch(head: string, tokens?: string[]): boolean;
  has(name: string): boolean;
  get(name: string): Command | undefined;
  getNode(name: string | string[]): Command | undefined;
  getAll(): Command[];
  setExecutionGuard(guard: ExecutionGuard): void;
}

export interface BoundCommands extends ServiceRef<CommandService> {
  command(name: string, description?: string, meta?: CommandMeta): CommandBuilder;
}
```

Builder 链式追加 `alias / option / action / usage / example`。`commands.command` 把 `pluginName` 填成本次激活 id；撤回时只摘自己那一层。不要自己调不带 `contextId` 的 `unregister`。

重要类型：

- **命令名 = 完整点路径**（`'memory.clear.all'`）。名字段必须匹配 `^[a-z][a-z0-9-]*$`。
- **inline DSL**：`<name:type>` 或 `[name:type]`，`type ∈ string|number|boolean|text`。`text` 会吞掉剩余 token。
- **CommandHandler**：`(argv: CommandArgv, ...positionals: unknown[]) => ...`。返回字符串即回复，`undefined` 则静默。
- **ExecutionInput.skipConfirm**：供 scheduler 等跳过交互确认，不绕过授权。

---

## 2. 谁提供 / 谁消费

**唯一参考实现**：`@aalis/plugin-commands`。`provides: [commands]`，`uses` 含 `gateway` required，`provide(commands, registry)`。入站分发发生在 `INBOUND_PHASE.COMMAND`。运行时依赖 `@aalis/api-authority` 的 `riskDefaults`。

**典型消费点**：`plugin-authority`、`plugin-agent`、`plugin-doctor`、`plugin-tool-system`、`plugin-user-profile`、`plugin-user-relation`、`plugin-maimai` 等。`commands` 几乎总是 optional。`plugin-authority` 用 `commands.follow(svc => { svc.setExecutionGuard(guard); ... })` 注入守卫。

---

## 3. 写一个 provider（替换指令引擎，高级）

**最小必须实现**：`CommandService` 全部方法。

- `command()` 返回的 builder 必须支持热转发与重放。绑定门面用 `follow` 在提供者每次上线时重放积压调用。
- `execute()` 在调用 handler 之前必须先执行已注入的 `ExecutionGuard`。
- `parseCommand` / `hasMatch` 要能区分「带前缀但无人注册」与「已命中」。

```ts
import { commands, type CommandService } from '@aalis/api-commands';
import { gateway } from '@aalis/api-gateway';
import { definePlugin, provide } from '@aalis/core';

export default definePlugin({
  name: '@aalis/plugin-my-commands',
  provides: [commands],
  uses: { provide, gateway },
  apply({ provide }) {
    const svc = {} as CommandService;
    provide(commands, svc);
  },
});
```

同名 provider 胜者 = preference > priority > 注册顺序。

---

## 4. 标准消费方式：登记命令

```ts
import { commands } from '@aalis/api-commands';
import { definePlugin, optional } from '@aalis/core';

export default definePlugin({
  name: '@aalis/plugin-weather',
  uses: { commands: optional(commands) },
  apply({ commands }) {
    commands
      .command('weather <city:string> [day:number]', '查询天气')
      .option('unit', '-u <unit:string>', { choices: ['c', 'f'], default: 'c' })
      .example('/weather 北京')
      .action(async (argv, city, day) => {
        const unit = argv.options.unit as string;
        return `${String(city)} 天气（${String(day ?? 0)} 天后, ${unit}）…`;
      });
  },
});
```

option syntax 速查：

| syntax | 含义 |
| --- | --- |
| `'-v'` | boolean flag，别名 `v`。 |
| `'-p <page:number>'` | number 选项，别名 `p`，必带值。 |
| `'-p [page:number]'` | 值可选。 |
| `'<page:number>'` | 仅长名 `--page`，必带值。 |
| `'-t <type:string[]>'` | `string[]`。 |
| `''`（空） | 纯 boolean flag。 |

登记侧不用判断 `commands` 是否存在：builder 在提供者未就绪时缓存调用、上线后重放。若要读 `getAll()`，用 `commands.current`，每次现取，不要缓存。

**错误边界**：handler 抛错会被 `execute` 捕获，转成 `指令执行失败: <msg>`。

---

## 5. 能力 / 风险 → 影响

指令权限走两轴正交闸，与工具共用同一套 `ExecutionGuard`。

- **轴 A**：`visibility: 'public' | 'restricted'`
- **轴 B**：`confirm: 'session' | 'always'`
- **risk 糖**：`safe` / `sensitive` / `dangerous`
- **沿点路径继承**
- **`skipConfirm: true` 只跳确认弹窗，授权仍评估**

声明写在 `commands.command` 的第三参 `meta` 上：

```ts
// risk 糖一次设定两轴默认：dangerous = restricted + confirm:'session'
commands.command('weather.reset', '清空天气缓存', { risk: 'dangerous' }).action(async () => '已清空');
// 显式声明覆盖 risk 推导：每次都确认
commands.command('weather.purge', '删除全部天气数据', { risk: 'dangerous', confirm: 'always' }).action(async () => '已删除');
// 只收紧可见性、不要求确认；子命令（weather.admin.*）沿点路径继承
commands.command('weather.admin', '天气管理', { visibility: 'restricted' });
```

handler 内对外抓取须走 `safeFetch`；文件读写走 storage URI。storage 不是沙盒。

---

## 6. 边界与注意事项

1. **ExecutionGuard 是 fail-open**：`plugin-authority` 未加载时全部 `restricted` 命令无闸放行。
2. **follow 重挂期间存在窗口**：守卫注入与命令执行独立；provider 换人瞬间理论上无守卫。
3. **同名命令静默覆盖**。第三方应加领域前缀。
4. **位置参数都是 `unknown`**。
5. **`text` 类型贪婪**，必须放在最后。
6. **纯关键词模式（prefix=''）需命中首段**。
7. **命令命中即终止入站管道**；带前缀却无人注册会放行到下游。

---

## 7. 交叉链接

- 概念：`docs/concepts/service-model.md`、`docs/concepts/lazy-service-access.md`、`docs/concepts/manifest-metadata.md`、`docs/concepts/security-model.md`、`docs/concepts/message-llm-pipeline.md`、`docs/concepts/storage-uri-grammar.md`。
- 内核文档：`docs/plugins/plugin-commands.md`、`docs/plugins/plugin-authority.md`、`docs/plugins/plugin-tools.md`、`docs/core/service.md`、`docs/core/context.md`。
