# plugin-media — 多模态媒体识别调度器

**包名**: `@aalis/plugin-media`  
**源码**: `packages/plugin-media/src/index.ts`

## 概述

注册 `media` 服务（`MediaService`），调度 vision / audio / video 三类媒体处理。内置 LLM-as-Processor adapter，把声明了 vision/audio 能力的 LLM 包装为 `MediaProcessor`；看图（含视频与动图的帧）的模型调用带上用途「识图」，转写语音（含视频的音轨）的带上用途「转写」；消息到达时的识别与转写另带消息所在的会话，`analyze_image` 带调用工具的会话（`DescribeInput.sessionId`、`TranscribeInput.sessionId`），供记账（见 [api-llm 的记账](../api/api-llm.md#记账)）。`analyze_image` 声明可转后台（让出时限用执行器的默认 30 秒）：本地识图模型慢时一张图可达数分钟，在前台等满让出时限还没结束就由 [plugin-tools](plugin-tools.md#转后台与后台任务) 的执行器转到后台；执行器给这次调用的中止信号经 `describeImage` 的 `signal`、`DescribeInput.signal` 一路交给识图的模型调用，中止时识图随之停下。向 agent 注册 preprocessor，归一化 `IncomingMessage.attachments` 并写入描述。视频处理先用 ffmpeg 抽关键帧，交给 vision 处理器做综合描述；`video.mode` 为 `frames+asr` 且 `audio.mode` 为 `enabled` 时，再用 ffmpeg 抽出音轨，交给音频处理器（Whisper/ASR 或能识别音频的 LLM）转写。两段文字分别加 `video.framePrefix` / `video.audioTrackPrefix` 前缀后拼接。本插件取代并删除了 plugin-image-recognition，图片、动图、视频、音频统一走 `attachments[]`。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-media',
  provides: [media],
  uses: {
    logger,
    config,
    lifecycle,
    events,
    hooks,
    provide,
    proc: processService,
    storage,
    llm: optional(llm),
    agent: optional(agent),
    asr: optional(asr),
    tools: optional(tools),
    memory: optional(memory),
    sessionManager: optional(sessionManager),
    doctor: optional(doctor),
  },
  apply(caps) { /* 见源码 */ },
});
```

## 图片到达时

- 识别用 `vision.prefer` 选出的识图处理器（留空按优先级自动选）。静态图先落盘、写成引用 `[图片 | ref:…]`，识别成功时描述写进引用：`[图片: <描述> | ref:…]`。
- 识别失败或返回空串：引用照留，描述写「获取或识别失败，内容未知」，主模型可以据引用再经 `analyze_image` 看一次。
- 没有任何能看图的模型（没有识图处理器，或选中的处理器不会描述图片；主模型若能看图，它自己就是处理器）：不识别，每张图只落盘写成不带描述的引用（与关掉 `vision.recognizeOnArrival` 时同一形态），这条消息另加一行 `[附了 N 张图，当前无法查看]`。这一行接在最后一张图的描述后面另起一行，不进任何引用的描述，消息存档的附件清单照样带上这些图的地址。OneBot 的图在适配器里已落盘、正文已带引用，这时只加这一行。
- 图片落盘失败（磁盘满、没有写权限）：记一条 warn，并写进 `media:processed` 报告里这张图的条目（`error`，以「图片落盘失败」开头）。还能识别时照常识别，描述不带引用（`[图片描述] <描述>`，缓存命中时同样）；不识别时描述写「获取或识别失败，内容未知」。识别随后也失败时，条目的 `error` 记的是识别的错误，落盘失败见那条 warn。

## 诊断

向 doctor 注册检查项 `service/media.vision`（「识图」）：没有能看图的识别模型时报 warn，说明后果（图片照样存下，主模型看不到内容）与修法（在模型服务里加一个能看图的模型，再到「图像识别 → 识别模型」里选它，留空则自动选用）；有了报 ok，写出当前的识别模型。没装 doctor 时不登记。

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `vision` | object | — | 图像识别 |
| `vision.prefer` | llm-ref | — | 识别模型：把图片转成文字描述的模型。留空则自动选择优先级最高的 vision LLM。 |
| `vision.recognizeOnArrival` | boolean | `true` | 接触到图片立即识别：开启：图片到达即识别，描述进档案与向量库（可被召回），未触发回复的消息也留下记忆。关闭：档案只留图片指针，主模型需要时再经 analyze_image 按需查看；此时图片内容不可被检索召回。 |
| `vision.delivery` | select | `'auto'` | 主模型看图方式：决定当轮附件与 analyze_image 的交付形态。 |
| `vision.maxTokens` | number | `300` | 描述最大 token |
| `vision.think` | boolean | `false` | 启用思考链 (thinking)：开启时按模型服务配置的默认思考档，识别质量可能提升但 token 成本上升；关闭时用模型最浅的一档（Ollama 即关闭思考）。模型不能调思考时不起作用。 |
| `vision.prompt` | textarea | `''` | 单图描述 prompt：填写后完全覆盖 auto 档（自路由）与 casual 档的描述 prompt；detailed/professional 档仍用各自内置模板。留空时 auto 档用内置自路由 prompt（模型看图自判类型给相应详略），casual 档用内置简洁模板。 内置简洁模板供参考：请像有经验的朋友一样看这张图，用自然中文客观描述实际可见的内容。先抓 1–2 个最值得注意的视觉重点——优先选「视觉意外/反常之处」：信息密度异常集中的区域、数量反常多或反常少的物体、与画面其他部分明显冲突的颜色或元素、不该出现却出现的东西、醒目的文字或表情包文案、明显的游戏/二次元/网络梗标志，再补充主体、场景、人物动作与表情、整体氛围。对确有把握、特征足够明确的游戏/动画/角色/网络梗，可以直接点名；但只要没把握，就老实描述外观、UI、配色、文字与画风，不要硬猜具体名字、更不要往热门作品上套——宁可说"看不出具体是什么"，也别硬认成 Minecraft/原神/明日方舟之类（认错比模糊更糟）。 画面中若有数字（连胜天数、分数、价格、等级、日期、计数等），务必逐位看准、按画面实际像素如实读出，不要受对话上下文里出现过的旧数字影响（以图为准）。 **严格约束**：只描述图片本身可见的内容；不要主动推测发送者的情绪、动机、意图或心理状态，也不要把上下文/对话历史里提到但图片中不可见的人物、事件、动机写进描述。只有当图中文字、表情包文案、画面元素自身明确表达了某种情绪或动作意图（例如表情包模板自带语义、画面里有醒目的「求助」/「炫耀」文字等）时，才可以简短指出该信号。 控制在 200 字以内，不要 markdown，不要按 1)2)3) 列点，写成 1–2 段连贯文字。 |
| `vision.batchPrompt` | textarea | `''` | 多图批量描述 prompt：多张图片一起描述时使用（动图抽帧 / 图组）。留空则回落到“单图 prompt”或内置默认。 默认：以下是一组按顺序排列的图片，请综合所有图片做一段连贯的中文描述。先抓住整组图最值得注意的点：是同一场景的连拍/抽帧、还是各自独立的素材？是否构成时序变化、对比、剧情或梗？其次描述主体对象、人物动作、文字/表情包文案；画面中的游戏/动画/角色/网络梗仅在有把握时点名，没把握就客观描述外观与文字、不硬套热门作品。最后简短推测整组图想表达的事件、情绪或意图。画面中若有数字（分数、价格、计数、天数等）务必按实际像素逐位读准，不受上下文旧数字影响。控制在 250 字以内，不要 markdown，不要按 1)2)3) 列点，写成连贯文字。 |
| `audio` | object | — | 音频识别（转写 + 描述） |
| `audio.mode` | select | `'enabled'` | 模式 |
| `audio.prefer` | select | `''` | 处理后端：Whisper/ASR 与「能识别音频的 LLM」合在一个下拉里选；留空=按优先级自动。可选项随已装后端变化。 |
| `audio.language` | string | `''` | 默认语种 (ISO 639-1)：仅对 Whisper 类 ASR 生效；LLM-as-audio 会在 prompt 里作为提示。 |
| `audio.maxTokens` | number | `1024` | 最大输出 token：LLM-as-audio 专用。e4b 等小模型在 thinking enabled 下需 ≥1024，否则空响应。 |
| `audio.think` | boolean | `true` | 启用思考链 (thinking)：LLM-as-audio 专用。开启时按模型服务配置的默认思考档，识别质量更高但 token 成本 ×5-8；关闭时用模型最浅的一档（Ollama 即传 reasoning_effort=none）。模型不能调思考时不起作用。 |
| `audio.prompt` | textarea | `''` | 自定义 prompt：LLM-as-audio 专用。留空使用内置全能描述 prompt。 默认：请用中文描述这段音频的内容：若含语音/对话则转写为原文（中文用中文写，英文保留英文）；若含音乐则描述风格、乐器、情绪及可识别歌词；若是环境音/音效则描述场景；仅输出内容本身，不要 markdown 标记。 |
| `video` | object | — | 视频识别 |
| `video.mode` | select | `'frames+asr'` | 模式 |
| `video.maxFrames` | number | `5` | 最大关键帧数 |
| `video.framesHint` | textarea | `''` | 抽帧描述 hint：抽帧后拼帧下发 vision 模型时的 hint。留空使用默认：“以下为同一视频的关键帧，按时间顺序排列。” |
| `video.animatedPrompt` | textarea | `''` | 动图/短视频描述 prompt：`describeImage` 遇到动图时的整段描述 prompt（替换内置多图批量模板）；留空使用内置多图批量模板。 |
| `video.framePrefix` | string | `'[画面] '` | 画面描述前缀：拼到抽帧综合描述前的标记，例如 “[画面] …”。 |
| `video.audioTrackPrefix` | string | `'[音轨] '` | 音轨转写前缀：拼到视频音轨转写前的标记，例如 “[音轨] …”。 |
| `animatedImage` | object | — | 动图 / GIF |
| `animatedImage.maxFrames` | number | `5` | 最大关键帧数：动图（gif/webp 动画等）抽帧上限，与视频 video.maxFrames 独立。动图信息量较低，默认 5 已足够；调高会增加 vision 调用成本。 |
| `contextHistory` | object | — | 多模态上下文注入 |
| `contextHistory.enabled` | boolean | `true` | 允许多模态 processor 读取聊天上下文：启用后，图片描述 / 音频识别 / 视频抽帧调用多模态模型时，会将近期聊天记录拼到 prompt 里，让模型能联系上下文进行识别。对传统 Whisper-style ASR 后端无效。 |
| `contextHistory.maxMessages` | number | `4` | 上下文最大消息条数 |
| `senderContext` | object | — | 发送者画像注入 (vision) |
| `senderContext.enabled` | boolean | `true` | 允许在 vision 上下文中注入发送者 user-profile 摘要：启用后，vision 描述图片时会带上发送者的长期 fact 摘要（来自 plugin-user-profile），帮助模型理解 “草羊机截图 = Minecraft 玩家在炫耀” 类场景。读取失败微 user-profile 未启用时静默跳过，不会阻断识别。 |
| `senderContext.profileMaxChars` | number | `200` | profile 摘要最大字符数：超过截断。填 0 等于禁用 profile 注入。 |

## 相关

- `media` 服务契约与参考实现对照：[services/media.md](../services/media.md)
- 依赖的 `process` / `storage` 服务：[services/process.md](../services/process.md)、[services/storage.md](../services/storage.md)
- 可选依赖 `asr` 服务：[services/asr.md](../services/asr.md)
- ASR 参考实现：[plugin-asr-whisper-cpp.md](./plugin-asr-whisper-cpp.md)
