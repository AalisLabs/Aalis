# media 服务

`media` 把「媒体 → 文本」的多模态识别（图片描述、音频转写描述、视频抽帧加音轨）抽象成一个统一调度器。上层——agent preprocessor、工具、适配器——只需要向 `media` 提问，由它在一个 processor 池里仲裁并执行。这个池由「vision/audio LLM」与「独立的 ASR/Whisper backend」共同组成。

- **服务注册名**：`getService('media')`（字符串键 `media`，`ServiceTypeMap.media`）。
- **契约包**：`@aalis/api-media`。契约除了服务本身，还导出底层的 `MediaProcessor` 抽象。你写「非 LLM 的媒体 backend」时实现 `MediaProcessor` 再 `registerProcessor`；写「服务消费」时只用 `MediaService`。
- **参考实现**：`@aalis/plugin-media`，声明 `provides=['media']`，通过 `ctx.provide('media', svc)` 提供，实现类是 `MediaServiceImpl`。
- **它不是沙箱**：媒体的下载与落盘走 `safeFetch`（SSRF 守卫）加 `storage`，但 storage 本身不是隔离边界，详见 [§6](#6-能力风险--影响)。

这里有两层概念需要分清。`MediaService` 是一个真实可调用的服务实例，是有运行时的服务契约。`MediaProcessor` 则是给 backend 作者实现的「插件内子契约」——它不是独立的 DI 服务，而是注册进 `media` 服务内部池子的一个处理器对象。

---

## 1. 契约：核心类型与方法签名

### `MediaService`

```ts
export interface MediaService {
  // ----- processor 池管理 -----
  registerProcessor(p: MediaProcessor): () => void;                              // 注册非 LLM backend，返回注销函数
  listProcessors(cap?: MediaCapability): MediaProcessor[];
  pickProcessor(cap: MediaCapability, prefer?: string | ModelRef | null): MediaProcessor | null;

  // ----- 批量识别（按 attachment.kind 自动选 processor）-----
  describe(attachments: MessageAttachment[], opts?: DescribeOptions): Promise<Array<string | undefined>>;
  transcribe(attachment: MessageAttachment, opts?: TranscribeOptions): Promise<string | undefined>;

  // ----- 一站式：处理整条入站消息（preprocessor 内部用，外部一般不直接调）-----
  processMessage(msg: IncomingMessage): Promise<MediaProcessReport>;             // 把每条附件描述写进 msg._attachmentDescriptions

  // ----- 单图/单视频主动识别 + 描述缓存 -----
  describeImage(imageUrl: string, opts?: DescribeImageOptions): Promise<string>; // 带 24h 缓存；失败返回空串
  describeVideo(videoUrl: string, opts?: DescribeVideoOptions): Promise<string>; // 抽帧+可选音轨；失败返回空串
  lookupDescription(imageUrl: string): string | null;                            // 只查缓存不触发识别
  rememberDescription(imageUrl: string, description: string): void;
  buildContext(msg: IncomingMessage, opts?: BuildContextOptions): Promise<string>; // 为含图消息造视觉上下文 hint
}
```

取服务：`ctx.getService<MediaService>('media')`；`plugin-media` 未就绪时返回 `undefined`。

### `MediaProcessor`（backend 子契约）

一个 backend 声明它能处理哪些动作，并实现对应方法。按 cap 二选一或两者都实现：

```ts
export interface MediaProcessor {
  name: string;                 // 唯一标识，建议 `<provider>:<modelOrKind>`
  capabilities: MediaCapability[];
  displayName?: string;         // UI 用
  priority?: number;            // 数值大者优先（同 cap 多 processor 仲裁），默认 0
  describe?(input: DescribeInput, ctx: Context): Promise<DescribeResult>;    // vision/document.image/video.passthrough
  transcribe?(input: TranscribeInput, ctx: Context): Promise<TranscribeResult>; // audio
}
```

### `MediaCapability`

四个取值，分别对应四类处理动作：

- `'vision'`：图描述，含动图抽帧整合。
- `'audio'`：音频转文本，同一个 cap 同时覆盖语音转写与音乐/环境音描述。
- `'video.passthrough'`：原生视频 LLM 直通。
- `'document.image'`：文档内嵌图的 OCR/理解。

注意 `MediaCapability` 与 LLM 的 `Capability` 语义不同：前者描述「处理动作」，后者描述「模型能力」。两者不在同一个 DI capability 体系里，详见 [§6](#6-能力风险--影响)。

### 输入/输出类型

- **`DescribeInput`**：`attachments`，加上 `basePrompt`（完整替换默认 base）/ `hint`（在 base+context 之后追加一条约束）/ `context`（对话上下文，processor 可拼进 prompt）/ `maxTokens` / `mode:'single'|'combined'`。
  - `basePrompt` 与 `hint` 的语义严格分离：要换整段 prompt 用 `basePrompt`，只加一条要求用 `hint`。把整段 prompt 塞进 `hint` 会与默认 base 冲突。
- **`DescribeResult`**：`descriptions`（`mode=single` 时与 `attachments` 等长；`mode=combined` 时是单元素），加上 `meta?:{processor,model?,tokens?}`。
- **`TranscribeInput`**：单条 `attachment`，加上 `language?`（ISO 639-1）/ `withTimestamps?` / `context?`（仅对 LLM-as-audio 有意义，传统 Whisper 忽略）。
- **`TranscribeResult`**：`text` / `segments?` / `language?` / `meta?:{processor,model?}`。
- **服务层 opts**：`DescribeImageOptions`（含 `detailLevel` 档位，详见 [§6](#6-能力风险--影响)）、`DescribeVideoOptions`、`DescribeOptions`/`TranscribeOptions`（含 `prefer`，强制选定 processor）、`BuildContextOptions`。
- **`MediaProcessReport`**：`{ total, successCount, items[] }`，`items` 与 `msg.attachments` 等长，每条含 `{kind,cap?,processor?,description?,error?}`。

### 事件（declaration merging）

`'media:processed': [{ sessionId, report }]`。一条入站消息的所有附件处理完毕后发出，无论成功还是失败都会发，供 webui、archive、调试等消费。

---

## 2. 谁提供 / 谁消费

### 提供方

| 包 | 角色 |
| --- | --- |
| `@aalis/plugin-media` | 唯一的 `media` 服务提供者兼调度器。内置 LLM-as-Processor adapter，自动把所有在 `capabilities` 里声明了 vision/audio 的 LLM 包成 `MediaProcessor`（name 格式 `llm:${contextId}#${capShort}`）；同时把核心 `asr` 服务的每个 provider 桥接成 cap=`audio` 的 processor（name 格式 `asr:${contextId}`）。 |
| `@aalis/plugin-asr-whisper-cpp` / `@aalis/plugin-asr-openai` | 不直接 provide `media`，而是 provide 核心 `asr` 服务（`subsystem='media'`）。media 会自动把它们纳入 audio 池。写一个音频 backend 时应优先写成 `asr` provider，而非 `MediaProcessor`，见 [§4](#4-写一个-provider)。 |

### 典型消费点

| 包 | 调用 | 说明 |
| --- | --- | --- |
| `plugin-media`（自身 preprocessor） | `svc.processMessage(msg)` | 经 `buildPreprocessor` 注册到 agent |
| `plugin-file-reader` | `media.describeImage(uri)` | 识别 DOCX 内嵌图；先判 `if (!media?.describeImage) return ''` |
| `plugin-image-sender` | `media.describeImage(url, { detailLevel: 'casual' })` | 给候选图打描述以挑图 |
| `plugin-adapter-onebot` | `media.lookupDescription(url)` | 只复用缓存、不触发识别 |
| `plugin-message-archive` | `getService('media')` | 归档时取描述；`inject.optional:['media']` |
| `plugin-webui-server` | `ctx.getService('media') !== undefined` | 探测是否启用 |

---

## 3. 服务模型背景

有三条前提对使用 `media` 是必要的：

- DI 按**名字**解析，`media` 在全局只有一个赢家：偏好 > priority > 注册顺序。0.5.0 起**没有** capability-based 的服务选择——capability 概念活在 `MediaProcessor.capabilities`（实例内部池）里，不是 DI 的选择维度。见 [docs/concepts/service-model.md](../concepts/service-model.md)。
- 消费方**每次用都重新 `getService('media')`**，不要缓存实例——provider bounce 或 reload 会让旧引用失效。见 [docs/concepts/lazy-service-access.md](../concepts/lazy-service-access.md)。
- manifest 的双源（`package.json` 里的 `aalis.service` 与模块导出的 `provides`/`inject`）需要保持一致。见 [docs/concepts/manifest-metadata.md](../concepts/manifest-metadata.md)。

---

## 4. 写一个 provider

先决定走哪条路：

| 你的 backend 是… | 怎么接入 |
| --- | --- |
| **vision / audio 的 LLM** | 什么都不用做。只要你的 LLM provider 在 `capabilities` 里声明了 vision/audio，`plugin-media` 的内置 adapter 会懒扫描并自动把它包成 `MediaProcessor`。 |
| **音频转写 backend**（whisper / 云 ASR） | 写成 `asr` provider，实现 `ASRService`（`@aalis/api-asr`，单方法 `transcribe`）。media 会自动把它桥接进 audio 池。可参考 `plugin-asr-whisper-cpp`。这是首选做法——它能同时被「直接消费 `asr`」与「经 media 调度」两条路用到。 |
| **非 LLM 的图/视频 backend**（如自建 OCR、专用识别服务） | 实现 `MediaProcessor`，再 `media.registerProcessor(p)`。 |

### 4a. 不要重新 provide `media` 服务

`media` 调度器只应有一个实现（`plugin-media`）。你**不要** `ctx.provide('media', ...)`——那会和官方调度器争抢同名服务的赢家位置。你要做的是往现有调度器里**注册 processor**，或者**写一个 `asr` provider**。

### 4b. 注册一个 `MediaProcessor`（非 LLM backend 骨架）

```ts
import type { Context } from '@aalis/core';
import type { DescribeInput, DescribeResult, MediaService } from '@aalis/api-media';

export const name = '@aalis/plugin-my-ocr';
export const inject = { required: ['media'] }; // media 是硬依赖时写 required

export function apply(ctx: Context): void {
  const media = ctx.getService<MediaService>('media');
  if (!media) return; // 防御：media 未就绪

  const dispose = media.registerProcessor({
    name: 'my-ocr:default',               // 建议 <provider>:<kind>
    capabilities: ['vision'],             // 或 ['document.image']
    displayName: '自建 OCR',
    priority: 10,                          // > 0 优先于默认 LLM(priority=0)
    async describe(input: DescribeInput, _ctx): Promise<DescribeResult> {
      // input.mode 'single' → 与 attachments 等长；'combined' → 单元素
      // 尊重 input.basePrompt（完整覆盖）/ input.hint（追加约束）/ input.context（仅参考）
      const out = await Promise.all(input.attachments.map(a => runOcr(a)));
      return { descriptions: out, meta: { processor: 'my-ocr:default' } };
    },
  });
  ctx.onDispose(dispose); // 必须：bounce/reload 时把自己从 media 池摘掉
}
```

### 4c. 写一个 `asr` provider（音频 backend 首选骨架）

```ts
import type { Context } from '@aalis/core';
import type { ASRService } from '@aalis/api-asr';

export const name = '@aalis/plugin-asr-xxx';
export const subsystem = 'media';           // 与 whisper-cpp/openai 一致归到 media 子系统
export const provides = ['asr'];

export function apply(ctx: Context): void {
  const impl: ASRService = {
    async transcribe(input, _ctx) {
      // input.attachment.data 可能是 storage URI / http(s) / data-URI（见 §6）
      const text = await callBackend(input.attachment, input.language);
      return { text, language: input.language, meta: { model: 'whisper-xxx' } };
    },
  };
  ctx.provide('asr', impl, { priority: 0 }); // 多 asr provider 由核心按偏好>优先级仲裁
}
```

任一 provider 都要同步 `package.json` 的双源：

```jsonc
{
  "aalis": { "service": { "provides": ["asr"], "inject": { "required": ["process", "storage"] } } },
  "keywords": ["aalis", "aalis-plugin"]
}
```

契约包本身（`api-media`）的 `package.json` 则是 `"aalis": { "types": true }` 加 `keywords:["aalis","aalis-api"]`——纯类型包不打 `aalis-plugin` 词。

---

## 5. 标准消费写法

```ts
export const inject = { optional: ['media'] };  // media 是可选增强时

async function handle(ctx: Context, url: string) {
  const media = ctx.getService('media');        // 每次用都重新取，不要缓存
  if (!media?.describeImage) {                   // 服务缺失 / 方法缺失双重保护
    return '未启用 media 服务';
  }
  // describeImage 失败返回空串（不抛），按空串降级即可
  const desc = await media.describeImage(url, { detailLevel: 'casual', hint: '挑出有猫的图' });
  return desc || '（识别失败）';
}
```

几个要点：

- **惰性取服务**：`plugin-message-archive`、`plugin-image-sender`、`plugin-file-reader` 都是每次现取（`getService`）再加 `if (!media?.xxx)` 守卫，对照见 [§2](#2-谁提供--谁消费)。
- **只复用缓存、不触发识别**：对引用消息里的图，OneBot 适配器只调 `lookupDescription(url)`，未命中就保持 `[图片]` 占位，不会主动消耗 vision token。
- **错误边界**：`describe`/`transcribe`/`describeImage`/`describeVideo` 内部都做了 try/catch，失败返回 `undefined` 或空串而非抛错。调用方按「空 = 降级」处理即可。
- **顺序识别更稳**：本地视觉模型多为单实例串行，`plugin-image-sender` 显式逐张识别而非并发，避免它们互相排队又同时超时。

---

## 6. 能力 / 风险 → 影响

### detailLevel 四档（`describeImage` 专用）

| `detailLevel` | 语义 | 实现 |
| --- | --- | --- |
| `'casual'` | 简洁日常（≤200 字、识梗、不列点）——聊天截图/表情包 | 直接用 `cfg.vision.prompt \|\| DEFAULT_VISION_PROMPT` |
| `'detailed'` | 详细识别（不限字数、信息密度高的图） | `DEFAULT_VISION_DETAILED_PROMPT` |
| `'professional'` | 专业题目（严格 LaTeX、几何坐标、反幻觉）——数理化题 | `DEFAULT_VISION_PROFESSIONAL_PROMPT` |
| `'auto'`（默认） | 单次推理自路由：模型看图自判类型并按类型给相应详略（拿不准按文字密集图完整识别） | `cfg.vision.prompt \|\| DEFAULT_VISION_AUTO_PROMPT` |

四档都是一次 vision 调用。只想要短描述（例如挑图预览）传 `'casual'` 用简洁模板，`plugin-image-sender` 即如此；`cfg.vision.prompt` 填写后覆盖 auto 与 casual 两档，detailed/professional 不受影响。

### 描述缓存

缓存基于 `@aalis/util-bounded-map`（有界，加滑动 TTL，加 LRU），配置为 `max=1000` 条、`ttlMs=24h`。key 是 url / data-URI / 本地路径；值只存裸描述，ref 标记等包装由各消费点重建。

`describeImage` 只在「无 hint 且未 `noCache`」时读写缓存——**带 hint 不进缓存**，因为不同意图的结果不同。空串以及 `[图片:` / `[动图:` 这类占位都不会写入。`lookupDescription`/`rememberDescription` 则暴露给适配器做手动复用。

### storage URI 用法（provider 与调度器都要懂）

内部的 `cacheImageRef` 在三种字符串形态间分流，顺序很重要：

1. `http(s)://` → 原样保留（下载走 `safeFetch`，见下）。
2. `isStorageUri(data)` 命中（即 storage 路径，含 `data:/...`，OneBot 已落盘）→ 转成相对路径 `root/rest`。
3. 否则若 `data.startsWith('data:')`，当作 base64 data-URI 解码，经 `storage.writeFile` 落盘到 `data:/images/{session}/{hash}.{ext}`。

::: warning 先问 isStorageUri，再问 startsWith('data:')
`data:/images/x.jpg`（storage 根 `data`）与 `data:image/png;base64,...`（浏览器 data-URI）只靠冒号后是否紧跟 `/` 区分。判定顺序反了，会把 data-URI 误判成 storage 路径。完整文法见 [docs/concepts/storage-uri-grammar.md](../concepts/storage-uri-grammar.md)（§3 `data:/` 与 data-URI），它直接以本服务为示例。
:::

临时帧与下载产物经 `proc.makeTempDir` 加 `tmp.uri` 写盘，用完 `cleanup`。

### SSRF：所有远程下载必须走 safeFetch

由 LLM 或用户输入触发的 URL 下载是 SSRF 高危面（`169.254.169.254`、`127.0.0.1`、`10.0.0.0/8`）。`plugin-media` 一律走 `safeFetch`（`@aalis/util-network-guard`），它包含协议/host/逐跳重定向校验，加 20 MiB 体积上限，加 15s 超时，与 webui 的 image proxy 共用同一套规则。见 [docs/concepts/security-model.md](../concepts/security-model.md)。

::: warning backend 自行下载也必须用 safeFetch
你写 backend 时若要自己下载远程媒体，必须用 `safeFetch`，不要裸调 `fetch`。
:::

### authority / 隔离

`media` 服务本身不挂 authority 的 risk/visibility 门——它是 preprocessor 链路上的内部增强，调用语境（agent / 工具）由各自的 authority 把关。

不过落盘路径按 `session` 做了 key 隔离（`images/{safeSession}`），`buildContext` 也只读当前会话历史。provider 实现新的存储路径时，应延续按 session 隔离，不要跨会话泄漏。

### storage 不是沙箱

media 经 `storage` 写临时/缓存文件，但 storage 只是命名根加权限位，**不是进程级隔离**；ffmpeg 子进程经 `process` 服务运行，同样不是沙箱。详见 [docs/services/storage.md](./storage.md) §6 与 [docs/services/process.md](./process.md)。

---

## 7. 边界与注意事项

- **runtime 单例依赖**：media 内部的 ffmpeg 与远程下载逻辑经模块级 `setMediaRuntime({proc,storage})` 注入依赖，在 `apply()` 时设置。若 `process`/`storage` 未启用，`getMediaRuntime()` 会抛错——因此 `inject.required:['process','storage']`。第三方 backend 若要自己拿依赖，请走 `ctx`，不要依赖 media 的内部 runtime。
- **audio.prefer 下拉是 live mutate 的**：`media` 监听 `service:registered`/`service:unregistered`（asr/llm），动态刷新 `configSchema.audio.fields.prefer.options`。新装 asr 或 audio-LLM 后，选项会自动出现。这意味着 `configSchema` 对象在运行时被改写，前端配置页读的是这个 live 对象。
- **空音频描述不等于「非语音」**：模型的空响应可能是 maxTokens 不足、上下文超限或超时，这些都被统一标为 `[音频] 识别失败（…详见日志）`。不要据此判断「这段音频没人声」。
- **直通类模式不调 processor**：`vision.mode='passthrough'`/`'passthrough-raw'` 或 `audio.mode='passthrough'` 时，`processMessage` 不做识别，保留原始 attachment 让主模型直接吃。这要求主模型自身具备 vision/audio 能力，否则附件等于被丢弃。
- **`describe`/`disabled` 不向主模型交图**：识别是视觉模型的职责，结果已作为文字拼进消息正文，出口会把末条 user 消息的 `images` 清空。再把原图递一份给主模型等于同一张图识别两遍——实测一张 57KB 的图额外多花约 1,090 token、4.7 秒预填充。需要主模型亲自看图请改用直通模式，或让它按需调 `analyze_image`。
- **`passthrough` 与 `passthrough-raw` 的分界在动图**：`passthrough` 会在出口（`agent:llm:before` 中间件）把动图抽帧为多张静图（帧数上限 `animatedImage.maxFrames`），再交给主模型——主流视觉 API 对原始 GIF 只读首帧或拒收，抽帧是让"动"被看见的唯一通用形态；静图始终原样。`passthrough-raw` 不抽帧、动图整图交出，仅当主模型能原生理解动图（或做 API 行为实验）时使用。变换只作用于末条 user 消息、每条消息只处理一次（成败皆不重来），dryRun 估算轮跳过。
- **直通两档必须过形态规范化**：适配器给 `attachment.data` 的是内容寻址的相对路径 ref（`data/images/…`），而 provider 只认 data URI / http / `file://` / 绝对路径。裸路径会被当作 base64 送出去，触发 `illegal base64 data at input byte N`（整轮请求 400）。出口统一物化成 data URL，已是合法形态的逐字节原样；交不出合法形态的那一张丢弃并告警。
- **描述缓存跨会话共享是有条件的**：缓存键取落盘路径里的内容哈希，同一张表情包跨群只识别一次；但当 `contextHistory`/`senderContext` 开启、描述里掺进了本会话的对话语境时，键退回含会话目录的原路径，只在本会话内复用——否则 A 群的语境会随描述串到 B 群。缓存有快照落盘（`data:/media/descriptions.json`），进程重启不必重认。
- **video.passthrough cap 与帧抽取是两条路**：`video.maxTokens`/`think`/`prompt` 只对原生视频 LLM（`video.passthrough`）生效；默认的「抽帧 → vision」路径用的是 `vision.maxTokens`。
- **缺 ffmpeg/ffprobe 时视频降级为占位**：抽帧或抽音轨失败时返回 `[视频] …` 占位串而非空串，让主 LLM 知道有视频到达但读不了，避免幻觉。

---

## 8. 交叉链接

- 概念：[service-model](../concepts/service-model.md)（DI 按名仲裁、无 capability 选择）｜[lazy-service-access](../concepts/lazy-service-access.md)（每次 getService、别缓存）｜[manifest-metadata](../concepts/manifest-metadata.md)（provides/inject 双源）｜[storage-uri-grammar](../concepts/storage-uri-grammar.md)（`data:/` 与 data-URI 区分，直接引本服务为例）｜[security-model](../concepts/security-model.md)（SSRF / safeFetch）｜[message-llm-pipeline](../concepts/message-llm-pipeline.md)（preprocessor 在消息链路的位置）。
- 服务：[storage](./storage.md)（落盘后端，非沙箱）｜[process](./process.md)（ffmpeg 子进程）｜[llm](./llm.md)（vision/audio LLM 自动成 processor）｜[message](./message.md)（`MessageAttachment` / `IncomingMessage` 类型源）｜[agent](./agent.md)（preprocessor 注册宿主）。
- 相关契约包：`@aalis/api-asr`（音频 backend 首选契约）。
