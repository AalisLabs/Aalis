# @aalis/api-contributions

贡献点契约：`contributions` 服务描述符、`ContributionSpec` / `ContributionHandle`、提供者契约 `ContributionRegistry`、共用的 id 校验 `assertContributionId` 与扩展点 `ContributionPointMap`。不含实现，默认提供者是 `@aalis/plugin-contributions`。

## 角色

- `contributions`：服务描述符。插件在 `uses` 里声明后得到绑定门面：`contribute(point, spec)` 交付一份 spec，局部 id 自动冠以本激活 id，同 id 重复交付即替换，随本次激活撤回；`collect(point)` 按全局键码元序枚举快照。
- 登记表只存数据、不执行插件代码；怎样调用 spec 由贡献点的收集方决定。
- `ContributionPointMap`：空接口，由各领域 `-api` 包经 declaration merging 注入「贡献点名 → spec 类型」。

## 安装

```bash
pnpm add @aalis/api-contributions
```

## 使用

```ts
import { contributions } from '@aalis/api-contributions';

// uses: { contributions }
contributions.contribute('agent:prompt', { id: 'persona', build: () => '...' });
const all = contributions.collect('agent:prompt');
```
