# trigger 服务

## 1. 定位

`trigger` 标记当前生效的**触发插件**。触发插件回答"这条入站消息要不要让 agent 开口"：它在 `inbound:trigger` 相位判定，放行的消息写好 `triggerType`，不开口的归档后吞掉。每个触发插件都是完整的判定，各自 `provide(trigger, 自己的实例)`，服务胜者即生效者，**二选一**：同一条消息只由生效者判定，其余触发插件直接放行、什么都不做。"现在能不能说"（禁言、冷却、限速）不归它管，由下一相位的 [flow-control](./flow-control.md) 把关。

- 服务注册名：`'trigger'`（描述符 `trigger`）
- 契约包：`@aalis/api-trigger`（描述符、服务接口，以及触发插件共用的函数）
- 触发插件：`@aalis/plugin-trigger-policy`（规则：点名、计数与评分，另有闲置主动开口）；仓库内的私有插件 `@aalis/plugin-trigger-laya`（模型：经本机侧车由 Laya 模型判定，不发布到 npm，说明见该包 README）
- 相邻相位：`inbound:command` → `inbound:trigger`（生效的触发插件）→ `inbound:flow`（flow-control）→ `inbound:dispatch`。

## 2. 契约

服务接口与描述符（`packages/api-trigger/src/index.ts`）：

```ts
export interface TriggerService {
  readonly label: string;
}

export const trigger = defineService<TriggerService>('trigger');
```

服务只用来选出生效者：触发插件拿 `trigger.current`（胜者）与自己的实例比身份，不调用方法。`label` 是触发插件的名字，进诊断（如 Laya 的诊断项报「生效的触发插件是某某」）；WebUI 服务页显示的是 `provide` 时传的 `label`，两处取同一个值。

触发插件共用的函数（同一文件）。写日志的函数由调用方传入日志前缀 `tag`（如 `'[laya]'`），告警行与调用方自己的日志同一前缀：

| 函数 | 作用 |
|---|---|
| `isActiveTrigger(phase, trigger, self)` | 这次入站是否由 `self` 判定。胜者每次入站只取一次，以这次的相位数据为键记在进程内全部 api-trigger 副本共用的表里（见 §5） |
| `hitsMuteKeyword(message, keywords)` | 正文是否包含任一禁言关键词；戳一戳通知恒不命中（正文是合成文案，内嵌戳者昵称） |
| `createBotNames(persona, sessionManager, logger, tag)` | 建一个名字表，返回 `(triggerNames, message) => string[]`：每次调用按 `message` 的会话现取别名与**全部**已登记人设（`persona.all()`）的名字、昵称的并集，去重、去空，别名在前。人设按会话取，与 agent 同一取法：`sessionManager.current.resolveConfig(sessionId, platform)` 的 `persona` 作为 `{ persona }` 传给每个提供者的 `getPersonaName` / `getNickNames`；session-manager 缺席时不带参数取，解析抛错时同样不带参数取并记一条 warn（同一原因只记一次）。某个人设读名字抛错时只跳过它的名字，记一条 warn，同一提供者同一原因只记一次（它读成功一次后再出错会再记）。触发插件激活时建一个 |
| `isAddressed(message, names, opts)` | 是否被点名：戳一戳只看 `triggerOnPoke`，不做 @ 与名字检测；其余消息看 `triggerOnAt` 的 `<at self>` 与名字检测（`names` 里任一个出现在正文里即命中，`names` 通常取自 `createBotNames`） |
| `markTriggered(message, addressed)` | 放行收尾：点名写 `triggerType = 'immediate'`，否则 `'interval'`；`interval` 在非私聊会话且消息未带 `actor` 时回填无主体授权 |
| `archiveSwallowed(message, archive, logger, tag)` | 吞掉前影子归档；message-archive 缺席时跳过，失败记 warn |

## 3. 谁提供 / 谁消费

**提供方**：每个触发插件提供一个实例，并以 `optional(trigger)` 声明本服务（自己提供的服务写 required 会把激活闸架在自己的产出上）。

| 插件 | 标签 | 优先级 | 判定 |
|---|---|---|---|
| `@aalis/plugin-trigger-policy` | 「规则（计数/评分）」 | 0 | 点名直接开口，否则按计数与活跃指数；同步判定。另有闲置主动开口 |
| `@aalis/plugin-trigger-laya`（私有） | 「Laya 模型」 | 10（`priority` 可配） | 模型分数 ≥ 阈值即开口，点名不强制开口；判定不了时只回点名 |

两个都启用时 Laya 生效。

**消费方**：只有触发插件自己，经 `isActiveTrigger` 判断是否生效；trigger-policy 的闲置主动开口到点时也查 `trigger.current` 是不是自己。

## 4. 写一个触发插件

触发插件在 `inbound:trigger` 挂中间件，第一步判断自己是不是生效者，其余步骤按需取用共用函数：

```ts
import { flowControl } from '@aalis/api-flow-control';
import { INBOUND_PHASE } from '@aalis/api-gateway';
import { hooks } from '@aalis/api-hooks';
import { messageArchive } from '@aalis/api-message-archive';
import { persona } from '@aalis/api-persona';
import { sessionManager } from '@aalis/api-session-manager';
import {
  archiveSwallowed,
  createBotNames,
  isActiveTrigger,
  isAddressed,
  markTriggered,
  type TriggerService,
  trigger,
} from '@aalis/api-trigger';
import { definePlugin, logger, optional, provide } from '@aalis/core';

export default definePlugin({
  name: '@aalis/plugin-my-trigger',
  provides: [trigger],
  uses: {
    logger,
    hooks,
    provide,
    trigger: optional(trigger),
    flowControl: optional(flowControl),
    persona: optional(persona),
    sessionManager: optional(sessionManager),
    messageArchive: optional(messageArchive),
  },
  apply(caps) {
    const self: TriggerService = { label: '我的触发判定' };
    caps.provide(trigger, self, { priority: 5, label: self.label });
    const botNames = createBotNames(caps.persona, caps.sessionManager, caps.logger, '[my-trigger]');

    caps.hooks.middleware(INBOUND_PHASE.TRIGGER, async (data, next) => {
      if (!isActiveTrigger(data, caps.trigger, self)) return next(); // 不是生效者：什么都不做
      const { message } = data;
      if (message.source) return next(); // 内部注入不经判定
      if (caps.flowControl.current?.isMuted(message.sessionId)) return next(); // 禁言期交给 flow 相位吞
      const opts = { triggerOnAt: true, triggerOnPoke: true };
      const addressed = isAddressed(message, botNames([], message), opts);
      const speak = await myJudge(message, addressed); // 自带超时，不抛错
      if (!speak) {
        await archiveSwallowed(message, caps.messageArchive, caps.logger, '[my-trigger]');
        return; // 吞掉
      }
      markTriggered(message, addressed);
      await next();
    });
  },
});
```

约束：

- 不是生效者时直接 `next()`，不计数、不识别、不归档、不请求外部服务。
- 带 `source` 的内部注入（闲置触发、定时任务、workflow、跨会话委派）直接放行，不改 `triggerType`（委派的 `proactive` 原样保留）。
- 作用域判断先于禁言关键词：否则群聊的禁言关键词会作用到私聊、WebUI 等作用域外的会话。
- 名字表取自全部人设提供者，按会话取：会话配置改用别的角色卡时，算点名的是那张卡的名字、昵称，主卡的不算，别的会话不受影响。同时装了多个人设插件时，叫其中任何一个的名字都算点名。某个人设读名字出错不影响判定：只少它的名字。
- 放行顺序：api-trigger 不要求触发插件按到达先后放行，也不提供共用的顺序处理。判定要等外部（附件识别、模型服务）时，同一会话先到的消息可能晚于后到的放行，后果见 §6。按到达先后处理同一会话的消息由通道层负责（网关入口按到达先后编号，同一会话的消息按到达先后排队与合并，当前消息取最新到达的），通道层尚未实现。
- 判定日志不含消息正文与昵称。

## 5. 行为不变量

- **二选一**。胜者按服务容器的规则解析：偏好 > 优先级 > 注册顺序。每条消息只由生效者判定；不生效的触发插件对这条消息不做任何事。
- **胜者每次入站只取一次**。`isActiveTrigger` 在相位里先跑到的触发插件处取下 `trigger.current`，以这次入站的相位数据为键记下（api-trigger 模块内的 `WeakMap`，经全局符号表取同一个对象：契约包装了两份、两个触发插件各用一份时仍共用这张表），后跑到的沿用它。判定途中切换偏好、停用或重载触发插件时，同一条消息不会被两个触发插件各判一次：在途消息由取下的那个判完；它若在轮到自己之前就被停用（中间件已从链上撤下），这条消息不经判定直接放行。
- **切换即时生效**。WebUI 服务页把 `trigger` 的偏好切到另一个触发插件，下一条消息起由它判定；停用生效的触发插件，下一条消息由剩下的接手。手改 `aalis.config.yaml` 的 `servicePreferences` 只在启动时读取，需重启才生效。
- **一个都不在时不做判定**。触发插件都停用或都没装时，`inbound:trigger` 相位不做判定，消息直接进入 flow 相位，不写 `triggerType`，与没装触发插件一致：agent 对每条消息都处理，只受 flow-control 的禁言、冷却与限速约束（冷却与限速只挡非 `immediate` 的消息，此时所有消息都不是 `immediate`）。
- **状态与配置不共享**。禁言关键词与时长、点名的别名与开关、作用域由各触发插件在自己的配置里分别设置，只有生效者的起作用：切换后按新生效者的配置执行，只在一边配了禁言关键词的，切到另一边后这些关键词不再生效；要在切换后保持一致，两边须同样配置。各触发插件的状态只属于自己：trigger-policy 的计数、活跃指数与闲置活动时间只统计它生效时经过的消息，不生效期间不计数；闲置主动开口到点时它不生效就跳过（不注入，也不记为 bot 开口），agent 回复也不记。
- **附件只识别一次**。要看附件描述的触发插件自己调 media 的 `processMessage` 启动识别（Laya 判定前至多等 `mediaWaitMs`）；放行与吞掉都不等识别跑完。media 的 `processMessage` 按消息对象只处理一次，agent 预处理器与归档对同一个消息对象调用时命中这次识别（在途则等它），不再识别第二遍。trigger-policy 不看附件，不启动识别。

## 6. 注意事项与边界情形

- trigger-policy 从不生效切回生效时，计数接着它上次生效时的状态算，不包含不生效期间的消息；闲置调度用的"最近活动"也只来自它生效时经过的消息与 bot 回复，切回后第一轮闲置可能按较早的活动时间到点。
- 模型类触发插件在判定之内等附件识别（Laya 至多 `mediaWaitMs`），带附件的消息可能晚于同一会话后到、不用等识别的消息放行。agent 按会话（与来源）latest-wins：新消息到达时中止同一会话仍在生成的回合，以新消息为当前消息接替。先到的消息晚放行时，若后到那一轮仍在生成，agent 会中止它，改以先到的为当前消息；后到的那条在它的回合开始时已经归档，中止不回滚，在接替回合里是可见的历史，但得不到针对它的回复。按到达先后处理由通道层负责（见 §4），通道层尚未实现。trigger-policy 同步判定，放行顺序即到达顺序。识别可能与 agent 的预处理链并发；media 与 file-reader 的写回都按写回那一刻的消息只补不换，不会互相覆盖。

## 7. 交叉链接

- [plugins/plugin-trigger-policy](../plugins/plugin-trigger-policy.md) — 规则判定的处理顺序、配置与闲置触发。
- [services/flow-control](./flow-control.md) — 下一相位的禁言、冷却与限速。
- [services/media](./media.md) — `processMessage` 与附件描述。
- [services/message](./message.md) — `buildIncomingContent`：与归档逐字一致的当前消息文本。
- [concepts/service-model](../concepts/service-model.md) — 多提供者的解析顺序（偏好 > 优先级 > 注册顺序）。
