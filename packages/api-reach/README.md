# @aalis/api-reach

触及契约：一次工具调用最多能触及本机的什么。类型、纯函数与服务描述符，服务由 `@aalis/plugin-reach` 提供。

## 角色

- 档位 `ACCESS_TIERS`（只读、修改确认、工作区、全权）与越界策略 `BoundaryPolicy`，经 declaration merging 成为会话设置的 `accessTier`、`accessOnBoundary` 两个键。
- `resolveReach`：按主体、房间类别、档位、越界策略、污点、场所、绑定与三张清单解析出一份触及；`judgeReach` 判一个目标放行、问或拒。
- `protectedLists`：按家目录布局、用户家目录与平台生成宿主控制面、持久化与自动执行落点、拒读清单；`matchesRule` 判一个路径落不落在某条规则里。工具边界与沙箱用同一份清单。
- `sandboxPolicyOf`：按触及生成沙箱策略 `SandboxPolicy`。
- 触及凭据 `ReachCredential` 的类型与品牌符号 `REACH_CREDENTIAL`、`isReachCredential`：凭据只由触及插件构造，工具从调用上下文取得后转交给存储与沙箱。
- 服务描述符 `reach`（`ReachService`）：`forCall` 按一次工具调用签发凭据，`markTainted` 记会话的污点，`provenanceOf` 查白纸的来源账本。

## 安装

```bash
pnpm add @aalis/api-reach
```

## 使用

```ts
import { judgeReach, protectedLists, resolveReach } from '@aalis/api-reach';

const lists = protectedLists({ paths, userHome, platform: process.platform, codeDirs: [] });
const reach = resolveReach({ principal: 'owner', roomClass: 'owner-only', tier: 'workspace', onBoundary: 'ask', /* … */ lists, paths });
judgeReach(reach, { effect: 'write', path: '/<项目>/src/a.ts' }); // { verdict: 'allow' }
```

规则详见文档站的 api-reach 页。

## 许可

见仓库根目录 LICENSE。
