# trigger 服务

## 1. 定位

`trigger` 回答"这条入站消息要不要让 agent 开口"。它是多提供者服务：相位宿主 `@aalis/plugin-trigger-policy` 占据 `inbound:trigger`，处理作用域、禁言、禁言关键词、计数与闲置等公共部分，再把"开不开口"逐个交给提供者判定，第一个不弃权的提供者说了算。"现在能不能说"（禁言、冷却、限速）不归它管，由下一相位的 [flow-control](./flow-control.md) 把关。

- 服务注册名：`'trigger'`（描述符 `trigger`）
- 契约包：`@aalis/api-trigger`
- 相位宿主兼规则提供者：`@aalis/plugin-trigger-policy`
- 相邻相位：`inbound:command` → `inbound:trigger`（宿主）→ `inbound:flow`（flow-control）→ `inbound:dispatch`。

## 2. 契约

完整接口（`packages/api-trigger/src/index.ts`）：

```ts
export interface TriggerInput {
  /** 当前入站消息。只读：triggerType、授权主体等由宿主在判定之后统一写 */
  message: Readonly<IncomingMessage>;
  /** 宿主识别的"被点名"：@ 自己、戳一戳、名字或别名命中 */
  addressed: boolean;
  /** 需要附件描述时调用：宿主按需识别并等待（有上限，永不抛错），多次调用共享同一次识别 */
  awaitAttachmentDescriptions(): Promise<void>;
}

export interface TriggerDecision {
  speak: boolean;
  /** 判定依据的简短说明，进宿主的判定日志；不要放消息原文 */
  reason: string;
  /** 可选的分数（如模型 logit），进宿主的判定日志 */
  score?: number;
}

export interface TriggerProvider {
  /** null = 弃权；抛错或超过宿主截止时间都按弃权处理。仅供相位宿主调用 */
  decide(input: TriggerInput): Promise<TriggerDecision | null>;
}

export const trigger = defineService<TriggerProvider>('trigger');
```

要点：

- `message` 标为只读：提供者只判定，不写消息，也不写会话状态。开口后的计数清零、`triggerType` 与授权主体由宿主统一写。
- `addressed` 由宿主按 trigger-policy 的 `triggerOnAt` / `triggerOnPoke` / `triggerNames` 与人设名字算出。规则提供者据此直接开口；模型提供者只把它当类别信息。无论谁开口，宿主都按它定类别：点名为 `immediate`（点名者即授权主体），否则为 `interval`（多人会话回填无主体授权）。
- `awaitAttachmentDescriptions()` 返回后，`message._attachmentDescriptions` 通常已写好；等待超过宿主的 `mediaWaitMs` 时照常返回，描述可能仍缺。不需要附件描述的提供者不要调用。

## 3. 谁提供 / 谁消费

**提供方**：

- `@aalis/plugin-trigger-policy` 的规则提供者：标签「规则（计数/评分）」，优先级 0（`packages/plugin-trigger-policy/src/index.ts`）。点名即开口，否则按 `intervalMode` 判定这条消息记入站那一刻的计数与活跃指数（宿主记入站时即算好，不受之后到达的消息影响）；不弃权，是兜底。
- 其它提供者（如判定模型）以更高优先级登记，排在规则提供者之前；未就绪、超时或处于影子模式时弃权，交给规则提供者。

**消费方**：只有相位宿主 `@aalis/plugin-trigger-policy`。它以 `optional(trigger)` 声明（本插件自己提供，写 required 会把激活闸架在自己的产出上），每条消息经 `trigger.all()` 现取全部提供者。

## 4. 写一个 provider

提供者插件只需 `provide(trigger, impl, { priority, label })`，不挂钩子。`label` 会出现在 WebUI 服务页与宿主的判定日志里。

```ts
import { trigger } from '@aalis/api-trigger';
import { buildIncomingContent } from '@aalis/schema-message';
import { definePlugin, provide } from '@aalis/core';

export default definePlugin({
  name: '@aalis/plugin-my-trigger',
  provides: [trigger],
  uses: { provide },
  apply({ provide }) {
    provide(
      trigger,
      {
        async decide({ message, addressed, awaitAttachmentDescriptions }) {
          if (message.attachments?.length) await awaitAttachmentDescriptions();
          const cur = buildIncomingContent(message); // 与归档逐字一致的当前消息文本
          const score = await myModel(cur, addressed); // 自带超时；无法判定（未就绪、出错、超时）时返回 undefined
          if (score === undefined) return null; // 弃权，交给后面的提供者
          return { speak: score >= 0, reason: 'my-model', score };
        },
      },
      { priority: 10, label: '我的判定模型' },
    );
  },
});
```

约束：

- `decide` 在宿主截止时间（`decisionTimeoutMs`，默认 2000 毫秒）内给出结论，否则按弃权处理；等附件识别的时间不计入。宿主放弃后不会取消提供者手里的请求，提供者应自带更短的超时。
- 不写 `message`，不依赖宿主的会话状态；需要历史上下文的自己从 memory 取。`reason` 里不放消息原文。
- 无法判定（未就绪、出错、超时）时返回 `null`，交给后面的提供者；判定为不开口时返回 `{ speak: false }`，这条消息会被影子归档后吞掉，后面的提供者不再被问。

## 5. 标准消费方式

只有相位宿主调用 `decide`。宿主的做法（`packages/plugin-trigger-policy/src/index.ts`、`consult.ts`）：

1. 按 `trigger.all()` 的顺序（偏好 > 优先级 > 注册顺序）逐个问，每次限时 `decisionTimeoutMs`；提供者调用 `awaitAttachmentDescriptions()` 等识别的那段暂停计时。
2. 返回 `null`、抛错、超时都记为弃权，转问下一个；第一个给出结论的提供者说了算。
3. 全部弃权（规则提供者在场时不会出现）时失败放行，与点名识别抛错时同一原则。
4. 每次判定记一行 debug 日志，不含消息正文：

```
[trigger] 判定 | session=<会话> | 决定者=<label> | speak=<true|false> | addressed=<true|false> | reason=<reason>[ | score=<score>] | 耗时=<n>ms[ | 弃权=<label>(弃权|超时|出错),…]
```

## 6. 行为不变量

- **规则提供者兜底**。它随宿主一起登记，不弃权；WebUI 服务页不能单独停用某个提供者，只能调偏好，所以宿主在场时总有提供者给出结论。
- **偏好即回滚开关**。WebUI 服务页把 `trigger` 的偏好切到「规则（计数/评分）」即时生效：规则提供者排到最前，它不弃权，后面的提供者不再被问。手改 `aalis.config.yaml` 的 `servicePreferences` 只在启动时读取，需重启才生效。
- **开口的后果与提供者无关**。任何提供者开口，宿主都清零计数与活跃指数、记触发时间、按 `addressed` 写 `triggerType` 与授权主体；不开口则影子归档后吞掉。
- **纯规则判定不等附件识别**。规则提供者不调用 `awaitAttachmentDescriptions()`，图片消息的判定延迟与没有模型提供者时相同。
- **附件只识别一次**。识别由第一个要描述的提供者触发（每条消息只启动一次）；宿主放行与归档都不等它跑完。media 的 `processMessage` 按消息对象只处理一次，agent 预处理器与归档对同一个消息对象调用时命中这次识别（在途则等它），不再识别第二遍。

## 7. 注意事项与边界情形

- 判定不加按会话的锁：同一会话接连到达的消息可能同时在判定。规则提供者按每条消息记入站那一刻的计数与活跃指数判定；判为开口、但这条判定期间本会话已有消息放行（计数已清零）时，这次开口作废，影子归档后吞掉，一簇突发消息只放行撞上阈值的那一条。点名的消息照常放行，其它提供者的判定不受此约束，逐条各自生效。
- 识别在判定期间启动时，宿主不等它跑完就把消息交给 flow 相位与 agent，余下的等待落在 agent 预处理器里，与没有模型提供者时相同。提供者自己等识别的那段（至多 `mediaWaitMs`）仍在判定之内，这期间同一会话后到的消息可能先抵达 agent。识别可能与 agent 的预处理链并发；media 与 file-reader 的写回都按写回那一刻的消息只补不换（media 只补 `mimeType` 与自己写的描述位，file-reader 只写文件附件的描述位），不会互相覆盖。
- 宿主放弃一个提供者（超时或已给出结论）后，它再调用 `awaitAttachmentDescriptions()` 直接返回，不启动识别，也不再计时。

## 8. 交叉链接

- [plugins/plugin-trigger-policy](../plugins/plugin-trigger-policy.md) — 相位宿主的处理顺序、配置与闲置触发。
- [services/flow-control](./flow-control.md) — 下一相位的禁言、冷却与限速。
- [services/media](./media.md) — `processMessage` 与附件描述。
- [services/message](./message.md) — `buildIncomingContent`：与归档逐字一致的当前消息文本。
- [concepts/service-model](../concepts/service-model.md) — 多提供者的解析顺序（偏好 > 优先级 > 注册顺序）。
