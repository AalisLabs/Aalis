# plugin-media — 多模态媒体识别调度器

**包名**: `@aalis/plugin-media`  
**源码**: `packages/plugin-media/src/index.ts`

## 概述

注册 `media` 服务（`MediaService`），调度 vision / audio / video 三类媒体处理。内置 LLM-as-Processor adapter，把声明了 vision/audio 能力的 LLM 包装为 `MediaProcessor`；看图（含视频与动图的帧）的模型调用带上用途「识图」，转写语音（含视频的音轨）的带上用途「转写」；消息到达时的识别与转写另带消息所在的会话，`analyze_image` 带调用工具的会话（`DescribeInput.sessionId`、`TranscribeInput.sessionId`），供记账（见 [api-llm 的记账](../api/api-llm.md#记账)）。`analyze_image` 声明可转后台（让出时限用执行器的默认 30 秒）：本地识图模型慢时一张图可达数分钟，在前台等满让出时限还没结束就由 [plugin-tools](plugin-tools.md#转后台与后台任务) 的执行器转到后台；执行器给这次调用的中止信号经 `describeImage` 的 `signal`、`DescribeInput.signal` 一路交给识图的模型调用，中止时识图随之停下；`describeImage` 与交给主模型前的规范化、抽帧（`transformModelImages`）把调用方的信号与本插件这次激活的合起来，调用方没中止、本插件停用或重启时下载、抽帧与识图同样停下。主模型直通时发出前抽帧被这样中止的，这条消息的图不再交出，这一轮照常往下。这一轮自己被停下时（`agent:llm:before` 的 `signal`），交给主模型前的下载与抽帧同样停下，钩子抛中止原因，这一轮按中止收尾。挂 `agent:input:before` 中间件，归一化 `IncomingMessage.attachments` 并写入描述。视频处理先用 ffmpeg 抽关键帧，交给 vision 处理器做综合描述；`video.mode` 为 `frames+asr` 且 `audio.mode` 为 `enabled` 时，再用 ffmpeg 抽出音轨，交给音频处理器（Whisper/ASR 或能识别音频的 LLM）转写。两段文字分别加 `video.framePrefix` / `video.audioTrackPrefix` 前缀后拼接。消息到达时的识别是本插件自己发起的，它的下载、抽帧、抽音轨与交给内置 LLM 处理器的识别接本插件这次激活的中止信号；`describe`、`transcribe` 与 `describeVideo` 把调用方给的 `signal` 与它合起来，交给内置 LLM 处理器的语音转码与转写、经 asr 桥接的转写（`TranscribeInput.signal`）、`describe` 的识图、`describeVideo` 的下载、抽帧与抽音轨：调用方中止或本插件停用、停机时这些随之停下，不等到各自的时限，到达识别也不再处理这条消息后面的附件；中止的附件记为出错，但不告警，描述位不写「未能识别」或「识别失败」（已落盘的图只留指针），`transcribe` 抛中止原因，`describe`、`describeVideo` 不告警。外部注册的处理器不接这个信号，已经开始的会运行结束。本插件取代并删除了 plugin-image-recognition，图片、动图、视频、音频统一走 `attachments[]`。

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
    asr: optional(asr),
    tools: optional(tools),
    memory: optional(memory),
    sessionManager: optional(sessionManager),
    authority: optional(authority),
    doctor: optional(doctor),
  },
  apply(caps) { /* 见源码 */ },
});
```

## 图片到达时

- 动图按读到的字节判：视频容器，或多帧的 GIF、APNG、动态 WebP 走抽帧（帧数上限 `animatedImage.maxFrames`），单帧 GIF 与别的图片按静图，扩展名、data URL 写的类型与适配器报的 mimeType 都不看；抽不出帧的（缺 ffmpeg、解码不了）退回整图识别，与直通出口同一条规则。网址来源先经 `safeFetch` 下载（20 MiB 上限）再判；静图按读到的字节转成 data URL（类型取判定结果）交给识别模型或主模型：网址不让提供方再下一次，存储地址与 data URL 不按扩展名或写着的类型猜。描述缓存里已有这张图的，直接用缓存，不再读来源。
- 识别用 `vision.prefer` 选出的识图处理器（留空按优先级自动选）。图先落盘、写成引用 `[图片 | ref:…]`，识别成功时描述写进引用：`[图片: <描述> | ref:…]`，静图与抽帧识别的动图同一形态。引用是存储地址：WebUI 上传的 base64 图落到本插件的子目录 `data:/images/<会话目录>/media/`（[会话媒体的目录约定](../services/media.md#会话媒体的目录约定)），落盘的地址另写在附件的 `ref` 上（消息存档的附件清单按它记）；适配器已落盘的原样用它的存储地址；正文里已有这个引用的（如 OneBot 的图）描述位不再重复写引用。
- 识别失败或返回空串：引用照留，描述写「获取或识别失败，内容未知」，主模型可以据引用再经 `analyze_image` 看一次。
- 没有任何能看图的模型（没有识图处理器，或选中的处理器不会描述图片；主模型若能看图，它自己就是处理器）：不识别，每张图只落盘写成不带描述的引用（与关掉 `vision.recognizeOnArrival` 时同一形态），这条消息另加一行 `[附了 N 张图，当前无法查看]`。这一行接在最后一张图的描述后面另起一行，不进任何引用的描述，消息存档的附件清单照样带上这些图的地址。OneBot 的图在适配器里已落盘、正文已带引用，这时只加这一行。
- 图片落盘失败（磁盘满、没有写权限）：记一条 warn，并写进 `media:processed` 报告里这张图的条目（`error`，以「图片落盘失败」开头）。还能识别时照常识别，描述不带引用（`[图片描述] <描述>`，缓存命中时同样）；不识别时描述写「获取或识别失败，内容未知」。识别随后也失败时，条目的 `error` 记的是识别的错误，落盘失败见那条 warn。

## 工具

- `analyze_image`：看一张图。来源可以是历史里的引用、存储地址（含 `data:/…`）、网址或 data URI；相对路径与 file_* 工具一致按工作区（`workspace:/`）找，不按首段补成别的根（`data/images/…` 也是工作区里的路径），找不到或过不了下面的判据时回错误并提示存储地址的写法；本机路径回「图片来源要写历史引用、存储地址或网址」。存储里的图先过[媒体判据](../services/media.md#媒体判据)：本会话收到或产生的图（目录名只对应本会话树里的会话的媒体目录里的，与本会话历史里记下的会话媒体）能看；别的会话的图按会话管理的取用规则，带这次调用的授权身份；不属于任何会话的本机文件只在这一轮的主体是 owner（或 owner 授权的自动运行在没有别人的会话里）时能看。几个人的一轮经工具调用上下文的 `approveFor` 逐个参与者判：某个参与者自己私聊里的图、别人过不了的，发一道参与者审批由他本人批；本机文件在有别人时由 owner 批，没有 owner 参与的一轮看不到。过不了的回「这张图不在这一轮能看的范围里」并说明两类规则，不读文件。过了判据的整读一次，按文件头认格式（[util-file-signature](../utils/README.md)），内容不是图片的拒绝（扩展名是图片也一样，owner 自己的会话也一样），mime 按认出的格式定。直通交付下 `data:/…` 存储地址同样按存储读取后交给主模型，只在 `acceptsImages` 为真时随结果交图，钉死 `passthrough` 也一样。直通交付下网址经 `safeFetch` 读进内存（不落临时文件），与 data URI 一样按文件头认是图片、写着的类型不看，不是图片的回错误。
- `update_image_description`：把识别结果写回调用所在会话历史里这张图的占位符；只改调用所在会话，不收会话 id 参数（多传的参数被执行器的参数校验拒绝）。它不在任何工具分组里，群里同样能写回。写回成功（改了至少一条）后发 `memory:messages-rewritten`，带改写后的整条：按改写前读到的那段历史（最近 200 条）、同一替换算出，向量记忆据此按带描述的正文重收录；更早的消息改到了也不在通知里。

## 参与 /clear

登记清理类型 `image`、`video`，`memory:clear`（`/clear` 与删除会话）里按所选类型清两样，各行标 `type`：

- 上传的图片（`image`）：本插件在会话媒体目录里的子目录，会话级清这个会话的，`/clear all` 清各会话的。
- 描述缓存：图片描述（`image`）与视频描述（`video`）各回一行，规则见 [media 服务的「描述缓存」](../services/media.md#描述缓存)。

## 诊断

向 doctor 注册检查项 `service/media.vision`（「识图」）：没有能看图的识别模型时报 warn，说明后果（图片照样存下，主模型看不到内容）与修法（在模型服务里加一个能看图的模型，再到「图像识别 → 识别模型」里选它，留空则自动选用）；有了报 ok，写出当前的识别模型。没装 doctor 时不登记。

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `vision` | object | — | 图像识别 |
| `vision.prefer` | llm-ref | — | 识别模型：把图片转成文字描述的模型。留空则自动选择优先级最高的能看图的模型。 |
| `vision.recognizeOnArrival` | boolean | `true` | 接触到图片立即识别：开启时图片一到就识别，描述写进历史，可被记忆检索到；关闭时只存图片引用，主模型需要时再查看，图片内容检索不到。 |
| `vision.delivery` | select | `'auto'` | 主模型看图方式：决定当轮附件与 analyze_image 的交付形态。`auto` 按 agent 交来的 `acceptsImages`（这一轮的主模型在模型服务登记了视觉能力）判，能看直通原图，不能看交描述，本插件不另查模型能力；端点没报告视觉能力的模型怎么补见 [media 服务](../services/media.md)。 |
| `vision.maxTokens` | number | `2048` | 描述最大 token：只防失控，模型因上限停下时在描述末尾标出「（已在长度上限处截断）」。须为正整数，否则实例转为出错 |
| `vision.think` | boolean | `false` | 启用思考链：开启时用模型的默认思考档，识别可能更准但更耗 token；关闭时用最浅的一档。模型不能调思考时无效。 |
| `vision.prompt` | textarea | `''` | 单图描述 prompt：填写后替换 auto 与 casual 档的描述 prompt，detailed 与 professional 档仍用内置模板。留空时用内置 prompt。 内置简洁模板供参考：请像有经验的朋友一样看这张图，用自然中文客观描述实际可见的内容。先抓 1–2 个最值得注意的视觉重点——优先选「视觉意外/反常之处」：信息密度异常集中的区域、数量反常多或反常少的物体、与画面其他部分明显冲突的颜色或元素、不该出现却出现的东西、醒目的文字或表情包文案、明显的游戏/二次元/网络梗标志，再补充主体、场景、人物动作与表情、整体氛围。对确有把握、特征足够明确的游戏/动画/角色/网络梗，可以直接点名；但只要没把握，就老实描述外观、UI、配色、文字与画风，不要硬猜具体名字、更不要往热门作品上套——宁可说"看不出具体是什么"，也别硬认成 Minecraft/原神/明日方舟之类（认错比模糊更糟）。 画面中若有数字（连胜天数、分数、价格、等级、日期、计数等），务必逐位看准、按画面实际像素如实读出，不要受对话上下文里出现过的旧数字影响（以图为准）。 **严格约束**：只描述图片本身可见的内容；不要主动推测发送者的情绪、动机、意图或心理状态，也不要把上下文/对话历史里提到但图片中不可见的人物、事件、动机写进描述。只有当图中文字、表情包文案、画面元素自身明确表达了某种情绪或动作意图（例如表情包模板自带语义、画面里有醒目的「求助」/「炫耀」文字等）时，才可以简短指出该信号。 控制在 200 字以内，不要 markdown，不要按 1)2)3) 列点，写成 1–2 段连贯文字。 |
| `vision.batchPrompt` | textarea | `''` | 多图批量描述 prompt：多张图片一起描述时使用（动图抽帧 / 图组）。留空则回落到「单图描述 prompt」或内置默认。 默认：以下是一组按顺序排列的图片，请综合所有图片做一段连贯的中文描述。先抓住整组图最值得注意的点：是同一场景的连拍/抽帧、还是各自独立的素材？是否构成时序变化、对比、剧情或梗？其次描述主体对象、人物动作、文字/表情包文案；画面中的游戏/动画/角色/网络梗仅在有把握时点名，没把握就客观描述外观与文字、不硬套热门作品。最后简短推测整组图想表达的事件、情绪或意图。画面中若有数字（分数、价格、计数、天数等）务必按实际像素逐位读准，不受上下文旧数字影响。控制在 250 字以内，不要 markdown，不要按 1)2)3) 列点，写成连贯文字。 |
| `audio` | object | — | 音频识别 |
| `audio.mode` | select | `'enabled'` | 模式 |
| `audio.prefer` | select | `''` | 处理后端：Whisper/ASR 与「能识别音频的模型」合在一个下拉里选；留空=按优先级自动。可选项随已装后端变化。 |
| `audio.language` | string | `''` | 默认语种 (ISO 639-1)：仅对 Whisper 类 ASR 生效；能识别音频的模型会在 prompt 里作为提示。 |
| `audio.maxTokens` | number | `2048` | 最大输出 token：只对能识别音频的模型生效，用来防止输出失控，思考与正文共用。因上限停下时在转写末尾标出「（已在长度上限处截断）」；须为正整数，否则实例转为出错。 |
| `audio.think` | boolean | `true` | 启用思考链：只对能识别音频的模型生效。开启时用模型的默认思考档，识别更准，但 token 消耗约为 5 到 8 倍；关闭时用最浅的一档。模型不能调思考时无效。 |
| `audio.prompt` | textarea | `''` | 自定义 prompt：只对能识别音频的模型生效。留空使用内置全能描述 prompt。 默认：请用中文描述这段音频的内容：若含语音/对话则转写为原文（中文用中文写，英文保留英文）；若含音乐则描述风格、乐器、情绪及可识别歌词；若是环境音/音效则描述场景；仅输出内容本身，不要 markdown 标记。 |
| `video` | object | — | 视频识别 |
| `video.mode` | select | `'frames+asr'` | 模式 |
| `video.maxFrames` | number | `5` | 最大关键帧数 |
| `video.framesHint` | textarea | `''` | 抽帧描述提示语：抽帧后拼帧交给能看图的模型时的提示语。留空使用默认：“以下为同一视频的关键帧，按时间顺序排列。” |
| `video.animatedPrompt` | textarea | `''` | 动图/短视频描述 prompt：描述动图时用的整段 prompt，替换内置的多图批量模板；留空用内置模板。 |
| `video.framePrefix` | string | `'[画面] '` | 画面描述前缀：拼到抽帧综合描述前的标记，例如 “[画面] …”。 |
| `video.audioTrackPrefix` | string | `'[音轨] '` | 音轨转写前缀：拼到视频音轨转写前的标记，例如 “[音轨] …”。 |
| `animatedImage` | object | — | 动图 / GIF |
| `animatedImage.maxFrames` | number | `5` | 最大关键帧数：动图（GIF、动态 WebP 等）最多抽几帧，与视频的帧数上限分开设。调高会增加识图开销。 |
| `contextHistory` | object | — | 多模态上下文注入 |
| `contextHistory.enabled` | boolean | `true` | 允许媒体识别读取聊天上下文：开启后，识别图片、音频与视频时把近期聊天记录一并交给模型，让它联系上下文识别。对 Whisper 类语音识别后端无效。 |
| `contextHistory.maxMessages` | number | `4` | 上下文最大消息条数 |
| `senderContext` | object | — | 发送者画像注入 |
| `senderContext.enabled` | boolean | `true` | 允许在识图时注入发送者的用户画像摘要：开启后，识别图片时带上发送者的用户画像摘要，帮助模型理解图片的用意。读不到画像时跳过，不影响识别。 |
| `senderContext.profileMaxChars` | number | `200` | 画像摘要最大字符数：超过截断。填 0 等于禁用画像注入。 |

`vision.recognizeOnArrival` 开启时，描述进档案与向量库（可被召回），没有触发回复的消息里的图也留下记忆；关闭时主模型经 `analyze_image` 按需查看。`vision.think` 与 `audio.think` 关闭时用模型最浅的思考档：Ollama 的识图即关闭思考，音频走兼容接口时传 `reasoning_effort: "none"`。`vision.prompt` 留空时，auto 档用内置的自路由 prompt（模型看图自判类型、给相应详略），casual 档用内置简洁模板。`video.animatedPrompt` 是 `describeImage` 遇到动图时用的 prompt。动图信息量较低，`animatedImage.maxFrames` 默认 5 已足够。`senderContext` 的画像摘要是发送者的长期事实摘要，来自 plugin-user-profile，帮助模型理解玩家发来自己游戏作品的截图是在炫耀这类场景；读取失败或没启用 plugin-user-profile 时静默跳过。

## 相关

- `media` 服务契约与参考实现对照：[services/media.md](../services/media.md)
- 依赖的 `process` / `storage` 服务：[services/process.md](../services/process.md)、[services/storage.md](../services/storage.md)
- 可选依赖 `asr` 服务：[services/asr.md](../services/asr.md)
- ASR 参考实现：[plugin-asr-whisper-cpp.md](./plugin-asr-whisper-cpp.md)
