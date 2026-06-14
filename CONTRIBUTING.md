# 参与 Aalis 开发

欢迎贡献！本文档约定开发环境、构建/校验流程、提交规范与分支策略。

## 0. 贡献授权 (CLA)

> 提交 PR 即视为同意以下条款。这是为了让 Aalis 能在**单一版权主体**下长期演进
> （含未来放宽许可证、双授权、商业化的可能）——这些只有在维护者持有完整再授权
> 权利时才可行。条款一次性、对所有贡献生效。

向本仓库提交贡献（PR / patch / 代码 / 文档），即表示你声明并同意：

1. **原创与有权贡献**：该贡献是你的原创，或你已获得合法授权提交它；不侵犯任何
   第三方权利（参照 [DCO](https://developercertificate.org/) 精神）。
2. **inbound = outbound**：你的贡献按其所在包当前的许可证授权他人使用
   （MIT 层即 MIT，AGPL 层即 AGPL-3.0）。
3. **再授权授予**：你额外授予版权持有人 **Ace Nyan** 一份永久、全球、不可撤销、
   免版税、可转授的许可，可**以任何条款（含专有 / 商业 / 重新许可）使用、复制、
   修改、分发、再授权你的贡献**，并将其纳入未来任意许可证版本的 Aalis（含其
   衍生与双授权版本）。你保留对自己贡献的著作权。

如不同意第 3 条，请勿提交 PR（可改为开 Issue 描述方案）。

## 1. 环境

| 工具 | 版本 |
|---|---|
| Node.js | ≥ 22.0（CI 跑 22 LTS） |
| pnpm | ≥ 10.0 |
| TypeScript | 5.7+ |

```sh
corepack enable                # 启用 pnpm 版本管理
pnpm install --frozen-lockfile  # 安装依赖
pnpm -r build                   # 全仓构建
pnpm dev                        # 运行 tsx src/index.ts
```

## 2. 校验三件套

提交前请确保通过：

```sh
pnpm ci             # = pnpm -r build && pnpm check:biome
pnpm check:biome    # 单跑 Biome
pnpm -r test        # 单元测试（vitest）
```

CI（`.github/workflows/ci.yml`）执行 `pnpm ci`，任何 Biome **error** 都会阻断合并。
warnings 不阻断但会审阅。

### 2.1 pre-push 自动守门（推荐）

仓库装了 husky，`pnpm install` 时会自动启用 `.husky/pre-push` hook：

```
git push   →   build → test → biome → knip   全过才放行
```

这等价于本地复现 CI 的所有阻断项，所以**只要本地能 push，CI 基本就过**。
任何一步失败 push 被拒绝。手动想跑相同检查：

```sh
pnpm preflight     # = build + test + biome + knip
```

紧急情况绕过：`git push --no-verify`（请确认 CI 仍会兜底 fail）。

### 2.2 编写测试的纪律

- **不要硬编码内部常量**（如 `expect(buf.length).toBe(2000)`）。改成引用导出的常量或断言性质（`toBeGreaterThan` 等），避免改默认值时连锁断 N 个测试。
- 新增 export 后请在本地 `pnpm exec knip` 验证无 unused，CI 会卡这个。
- 改 `*.tsx`/前端样式后即使本地能跑也要 `pnpm exec biome check .`，因为 biome 还做 lint 不只是 format。

## 3. 代码风格

- 由 [Biome](https://biomejs.dev) 自动管理：`pnpm format` 写格式，`pnpm lint:fix` 自动修复可修项。
- 命名遵循驼峰 + PascalCase 类；接口与类型不加 `I` 前缀。
- 不写废注释；只保留**讲清"为什么"**的注释。
- 公共 API 必须导出类型。优先用 `*-api` 包持有类型而非实现包。

## 4. 包结构

```
packages/
  core/                         # IoC + 生命周期，不依赖任何插件
  plugin-<name>-api/            # 仅类型 + Capability 声明合并，零运行时代码
  plugin-<name>/                # 实现，import 自己 + 别人的 *-api
```

类型包必须在 `package.json` 标注：

```json
{
  "aalis": { "types": true }
}
```

实现包必须声明 subsystem：

```json
{
  "aalis": { "subsystem": "agent" }
}
```

## 5. 提交规范（Conventional Commits）

```
<type>(<scope>): <subject>

[body]

[footer]
```

`type` 取值：

| 类型 | 含义 |
|---|---|
| `feat` | 新功能 |
| `fix` | 缺陷修复 |
| `refactor` | 不改语义的重构 |
| `perf` | 性能 |
| `docs` | 文档 |
| `test` | 测试 |
| `chore` | 构建/工具链 |
| `style` | 仅样式 |
| `revert` | 回退 |

`scope` 一般是包名去前缀：`core`、`agent-default`、`webui-server`、`tools-system` 等。

**示例**：

```
fix(webui-server): /api/service-groups 把 'app' 放入「核心」
refactor(agent-default): 拆出 messageProcessor / contextBuilder / replyDispatcher
test(core): Context.extend / Service / Plugin lifecycle 契约
```

破坏性变更在 footer 加：

```
BREAKING CHANGE: ServiceCapabilityMap 现在要求 declare module 合并
```

## 6. 分支策略

| 分支 | 用途 |
|---|---|
| `master` / `main` | 稳定 |
| `dev` | 日常集成 |
| `feat/<topic>` | 功能分支，长期可 rebase |
| `fix/<topic>` | 缺陷分支，短周期 |

PR 默认目标分支：`dev`。`master` 由 `dev` 通过 release PR 合并。

## 7. 编写插件

新插件 = 一个 `@aalis/plugin-<name>` 包，至少包含：

```ts
// src/index.ts
import type { App, Context, Plugin } from '@aalis/core';

export const name = 'my-plugin';
export const dependencies = ['llm'];          // inject.required
export const optionalDependencies = ['memory']; // inject.optional

export function apply(ctx: Context, config: MyConfig) {
  ctx.logger.info('my-plugin 已加载');
  ctx.provide('my-service', new MyService(ctx, config), {
    capabilities: ['feature-a', 'feature-b'],
  });
}
```

- 任何在 `ctx` 上注册的副作用（`on`/`provide`/`middleware`/`whenService`）都会
  在该 `ctx` dispose 时自动清理，无需手动维护清理列表。
- 不要把状态挂在 `globalThis`、模块级单例或不可清理的 `setInterval`，
  请用 `ctx.disposables`（通过 `whenService` / `on` 返回值自动入链）。

详见 [docs/architecture.md](docs/architecture.md) 与 [docs/plugins/](docs/plugins/)。

## 8. 反馈

- Bug：GitHub Issues
- 设计讨论：GitHub Discussions / Issues with `discussion` label
- 安全问题：私下邮件维护者（不要开公开 Issue）

谢谢！
