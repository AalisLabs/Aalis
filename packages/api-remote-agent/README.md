# @aalis/api-remote-agent

远端代理契约：`remote-agent` 服务描述符、提供者接口，以及按名取提供者与判定用的纯函数。把任务交给远端长期编码代理的是提供者插件，本包不含实现。

## 角色

- `remote-agent`：多提供者。每个提供者插件实例对应一个远端账号与模型的组合，各自 `provide(remoteAgent, 实例)`。
- 消费方按配置里写的提供者实例 id 用 `resolveRemoteAgent` 精确取，不存在就返回 `undefined`，不回落到偏好胜者或别的提供者。
- 共用的函数：`egressWithin`（报告的出网方式是否不超过上限，`unknown` 按 `open` 算）、`isTerminalRun`（一轮是否已到终态）、`isRemoteAgentError`（按名字认提供者抛出的 `RemoteAgentError`，进程里装有两份本包时也认得）。

## 安装

```bash
pnpm add @aalis/api-remote-agent
```

## 提供

服务描述符：`remoteAgent`（服务名 `remote-agent`），服务接口 `RemoteAgentProvider`。

```ts
import { remoteAgent, resolveRemoteAgent } from '@aalis/api-remote-agent';
```

提供者：Cursor 云端代理 `@aalis/plugin-remote-agent-cursor`。

## 文档

详见 [docs/api/api-remote-agent.md](../../docs/api/api-remote-agent.md)。

## 许可

见仓库根目录 LICENSE。
