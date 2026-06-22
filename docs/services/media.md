# media 服务

**一句话定位**：把「媒体 → 文本」的多模态识别（图片描述 / 音频转写描述 / 视频抽帧+音轨）抽象为统一调度器——上层（agent preprocessor、工具、适配器）只问 `media`，由它在「vision/audio LLM + 独立 ASR/Whisper backend」组成的 processor 池里仲裁并执行。

- **服务注册名**：`getService('media')`（字符串键 `media`，`ServiceTypeMap.media`，`packages/plugin-media-api/src/index.ts:240`）。
- **契约包**：`@aalis/plugin-media-api`（`packages/plugin-media-api/src/index.ts`）。契约还导出底层 `MediaProcessor` 抽象——第三方写「非 LLM 的媒体 backend」时实现它再 `registerProcessor`，写「服务消费」时只用 `MediaService`。
- **参考实现**：`@aalis/plugin-media`（`packages/plugin-media/src/index.ts`，`provides=['media']` 于 `:28`，`ctx.provide('media', svc)` 于 `:317`；实现类 `MediaServiceImpl` 在 `packages/plugin-media/src/service.ts:98`）。
- **它不是沙箱**：媒体下载/落盘走 `safeFetch`（SSRF 守卫）+ `storage`，但 storage 本身不是隔离边界，见 [§6](#6-能力风险--影响)。

> 这是一个**有运行时的服务契约**（`MediaService` 是真实可调用的服务实例）。同时 `MediaProcessor` 是给 backend 作者实现的「插件内子契约」——它不是独立 DI 服务，而是注册进 `media` 服务内部池子的处理器对象。

---

## 1. 契约：核心类型与方法签名

### `MediaService`（`packages/plugin-media-api/src/index.ts:113-159`）

```ts
export interface MediaService {
  // ----- processor 池管理 -----
  registerProcessor(p: MediaProcessor): () => void;                              // :115 注册非 LLM backend，返回注销函数
  listProcessors(cap?: MediaCapability): MediaProcessor[];                        // :117
  pickProcessor(cap: MediaCapability, prefer?: string | ModelRef | null): MediaProcessor | null; // :119

  // ----- 批量识别（按 attachment.kind 自动选 processor）-----
  describe(attachments: MessageAttachment[], opts?: DescribeOptions): Promise<Array<string | undefined>>; // :122
  transcribe(attachment: MessageAttachment, opts?: TranscribeOptions): Promise<string | undefined>;       // :124

  // ----- 一站式：处理整条入站消息（preprocessor 内部用，外部一般不直接调）-----
  processMessage(msg: IncomingMessage): Promise<MediaProcessReport>;             // :131 把每条附件描述写进 msg._attachmentDescriptions

  // ----- 单图/单视频主动识别 + 描述缓存 -----
  describeImage(imageUrl: string, opts?: DescribeImageOptions): Promise<string>; // :140 带 24h 缓存；失败返回空串
  describeVideo(videoUrl: string, opts?: DescribeVideoOptions): Promise<string>; // :146 抽帧+可选音轨；失败返回空串
  lookupDescription(imageUrl: string): string | null;                            // :149 只查缓存不触发识别
  rememberDescription(imageUrl: string, description: string): void;              // :152
  buildContext(msg: IncomingMessage, opts?: BuildContextOptions): Promise<string>; // :158 为含图消息造视觉上下文 hint
}
```

`useMediaService(ctx)`（`:221-223`）是取服务的 helper，等价于 `ctx.getService<MediaService>('media')`。

### `MediaProcessor`（backend 子契约，`:33-49`）

一个 backend 声明能处理哪些动作，并实现对应方法（按 cap 二选一或都实现）：

```ts
export interface MediaProcessor {
  name: string;                 // :34 唯一标识，建议 `<provider>:<modelOrKind>`
  capabilities: MediaCapability[]; // :37
  displayName?: string;         // :39 UI 用
  priority?: number;            // :41 数值大者优先（同 cap 多 processor 仲裁），默认 0
  describe?(input: DescribeInput, ctx: Context): Promise<DescribeResult>;    // :43 vision/document.image/video.passthrough
  transcribe?(input: TranscribeInput, ctx: Context): Promise<TranscribeResult>; // :48 audio
}
```

### `MediaCapability`（`:17-30`）

`'vision'`（图描述，含动图抽帧整合）｜`'audio'`（音频→文本，同一 cap 同时覆盖语音转写与音乐/环境音描述）｜`'video.passthrough'`（原生视频 LLM 直通）｜`'document.image'`（文档内嵌图 OCR/理解）。

> 注意 `MediaCapability` 与 LLM 的 `Capability` 语义不同：前者描述「处理动作」，后者描述「模型能力」。两者不在同一个 DI capability 体系里（见 [§6](#6-能力风险--影响)）。

### 输入/输出类型

- **`DescribeInput`**（`:51-77`）：`attachments` + `basePrompt`（完整替换默认 base）/ `hint`（在 base+context 之后追加一条约束）/ `context`（对话上下文，processor 可拼进 prompt）/ `maxTokens` / `mode:'single'|'combined'`。
  - ⚠️ `basePrompt` 与 `hint` 语义严格分离：要换整段 prompt 用 `basePrompt`，只加一条要求用 `hint`；把整段 prompt 塞进 `hint` 会与默认 base 冲突（`:54-67`）。
- **`DescribeResult`**（`:79-84`）：`descriptions`（`mode=single` 与 `attachments` 等长；`mode=combined` 单元素）+ `meta?:{processor,model?,tokens?}`。
- **`TranscribeInput`**（`:86-98`）：单条 `attachment` + `language?`（ISO 639-1）+ `withTimestamps?` + `context?`（仅 LLM-as-audio 有意义，传统 Whisper 忽略）。
- **`TranscribeResult`**（`:100-108`）：`text` + `segments?` + `language?` + `meta?:{processor,model?}`。
- **服务层 opts**：`DescribeImageOptions`（`:161-178`，含 `detailLevel` 档位，详见 [§6](#6-能力风险--影响)）、`DescribeVideoOptions`（`:180-187`）、`DescribeOptions`/`TranscribeOptions`（`:194-205`，含 `prefer` 强制选 processor）、`BuildContextOptions`（`:189-192`）。
- **`MediaProcessReport`**（`:207-218`）：`{ total, successCount, items[] }`，`items` 与 `msg.attachments` 等长，每条含 `{kind,cap?,processor?,description?,error?}`。

### 事件（declaration merging，`:227-235`）

`'media:processed': [{ sessionId, report }]`——一条入站消息所有附件处理完（成功或失败均发），供 webui / archive / 调试消费。

---

## 2. 谁提供 / 谁消费

### 提供方

| 包 | 角色 |
| --- | --- |
| `@aalis/plugin-media` | 唯一的 `media` 服务提供者 + 调度器。内置 LLM-as-Processor adapter，自动把所有声明 vision/audio 能力的 LLM 包成 `MediaProcessor`（`packages/plugin-media/src/llm-adapter.ts:269-280`，name 格式 `llm:${contextId}#${capShort}`）；并把核心 `asr` 服务的每个 provider 桥接成 cap=`audio` 的 processor（`service.ts:127-148`，name 格式 `asr:${contextId}`）。 |
| `@aalis/plugin-asr-whisper-cpp` / `@aalis/plugin-asr-openai` | 不直接 provide `media`，而是 provide 核心 `asr` 服务（`subsystem='media'`，见 `plugin-asr-whisper-cpp/src/index.ts:22`）。media 自动把它们纳入 audio 池。**写一个音频 backend 应优先写成 `asr` provider，而非 `MediaProcessor`**（见 [§4](#4-写一个-provider)）。 |

### 典型消费点

| 包 | 调用 | 位置 |
| --- | --- | --- |
| `plugin-media`（自身 preprocessor） | `svc.processMessage(msg)` | `service.ts:293` 经 `buildPreprocessor` 注册到 agent（`index.ts:350`） |
| `plugin-file-reader` | `media.describeImage(uri)` 识别 DOCX 内嵌图 | `plugin-file-reader/src/index.ts:374`（先判 `if (!media?.describeImage) return ''`） |
| `plugin-image-sender` | `media.describeImage(url, { detailLevel: 'casual' })` 给候选图打描述挑图 | `plugin-image-sender/src/index.ts:103, 286, 302` |
| `plugin-adapter-onebot` | `media.lookupDescription(url)` 只复用缓存、不触发识别 | `plugin-adapter-onebot/src/index.ts:980`、`forward-expand.ts:265` |
| `plugin-message-archive` | `getService('media')` 归档时取描述 | `plugin-message-archive/src/index.ts:117`（`inject.optional:['media']`） |
| `plugin-webui-server` | `ctx.hasService('media')` 探测是否启用 | `plugin-webui-server/src/index.ts:479` |

---

## 3. 服务模型背景（先读这几条）

- DI 按**名字**解析，`media` 全局只有一个赢家：偏好 > priority(`ServicePriority`) > 注册顺序。0.5.0 起**没有 capability-based 服务选择**——capability 概念活在 `MediaProcessor.capabilities`（实例内部池），不是 DI 选择维度。见 [docs/concepts/service-model.md](../concepts/service-model.md)。
- 消费方**每次用都 `getService('media')`**，不要缓存实例——provider bounce/reload 会让旧引用失效。见 [docs/concepts/lazy-service-access.md](../concepts/lazy-service-access.md)。
- manifest 双源（`package.json` 的 `aalis.service` vs 模块导出的 `provides`/`inject`）需一致。见 [docs/concepts/manifest-metadata.md](../concepts/manifest-metadata.md)。

---

## 4. 写一个 provider

先决策走哪条路：

| 你的 backend 是… | 怎么接入 |
| --- | --- |
| **vision / audio 的 LLM** | 什么都不用做。只要你的 LLM provider 在 `capabilities` 里声明了 vision/audio，`plugin-media` 的内置 adapter 会自动把它包成 `MediaProcessor`（`service.ts:510-539` 懒扫描）。 |
| **音频转写 backend**（whisper / 云 ASR） | **写成 `asr` provider**，实现 `ASRService`（`@aalis/plugin-asr-api`，单方法 `transcribe`）。media 自动桥接进 audio 池。参考 `plugin-asr-whisper-cpp`。这是首选——你能同时被「直接消费 `asr`」与「经 media 调度」两条路用到。 |
| **非 LLM 的图/视频 backend**（如自建 OCR、专用识别服务） | 实现 `MediaProcessor` 再 `media.registerProcessor(p)`。 |

### 4a. `media` 服务不该被你重新 provide

`media` 调度器只应有一个实现（`plugin-media`）。你**不要** `ctx.provide('media', ...)`——那会和官方调度器抢同名服务的赢家位置。你要做的是往现有调度器里**注册 processor**或**写 `asr` provider**。

### 4b. 注册一个 `MediaProcessor`（非 LLM backend 骨架）

```ts
// packages/plugin-my-ocr/src/index.ts
import type { Context } from '@aalis/core';
import { useMediaService } from '@aalis/plugin-media-api';
import type { DescribeInput, DescribeResult } from '@aalis/plugin-media-api';

export const name = '@aalis/plugin-my-ocr';
export const inject = { required: ['media'] }; // media 是硬依赖时写 required

export function apply(ctx: Context): void {
  const media = useMediaService(ctx);
  if (!media) return; // 防御：media 未就绪

  const dispose = media.registerProcessor({
    name: 'my-ocr:default',               // 建议 <provider>:<kind>
    capabilities: ['vision'],             // 或 ['document.image']
    displayName: '自建 OCR',
    priority: 10,                          // > 0 抢在默认 LLM(priority=0) 前
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
// packages/plugin-asr-xxx/src/index.ts
import type { Context } from '@aalis/core';
import type { ASRService } from '@aalis/plugin-asr-api';

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

`package.json` 双源同步（任一 provider 都要写）：

```jsonc
{
  "aalis": { "service": { "provides": ["asr"], "inject": { "required": ["process", "storage"] } } },
  "keywords": ["aalis", "aalis-plugin"]
}
```

> 契约包本身（`plugin-media-api`）的 `package.json` 是 `"aalis": { "types": true }` + `keywords:["aalis","aalis-api"]`（`packages/plugin-media-api/package.json`）——纯类型包不打 `aalis-plugin` 词。

---

## 5. 标准消费姿势

```ts
export const inject = { optional: ['media'] };  // media 是可选增强时

async function handle(ctx: Context, url: string) {
  const media = ctx.getService('media');        // 每次用都重新取，别缓存
  if (!media?.describeImage) {                   // 服务缺失 / 方法缺失双重保护
    return '未启用 media 服务';
  }
  // describeImage 失败返回空串（不抛），按空串降级即可
  const desc = await media.describeImage(url, { detailLevel: 'casual', hint: '挑出有猫的图' });
  return desc || '（识别失败）';
}
```

要点：

- **lazy 取服务**：`plugin-message-archive`、`plugin-image-sender`、`plugin-file-reader` 都是每次现取（`getService`）+ `if (!media?.xxx)` 守卫，对照见 [§2](#2-谁提供--谁消费) 各 file:line。
- **只复用缓存别触发识别**：引用消息里的图，OneBot 适配器只调 `lookupDescription(url)`（`plugin-adapter-onebot/src/index.ts:981`），未命中就保持 `[图片]` 占位，绝不主动烧 vision token。
- **错误边界**：`describe`/`transcribe`/`describeImage`/`describeVideo` 内部 try/catch，失败返回 `undefined` 或空串而非抛错（`service.ts:197,215,246` 等）。调用方按「空 = 降级」处理。
- **顺序识别更稳**：本地视觉模型多为单实例串行，`plugin-image-sender` 显式逐张识别而非并发（`index.ts:108-110`），避免互相排队同时超时。

---

## 6. 能力 / 风险 → 影响

### detailLevel 四档（`describeImage` 专用，`packages/plugin-media-api/src/index.ts:170-177`）

| `detailLevel` | 语义 | 实现 |
| --- | --- | --- |
| `'casual'` | 简洁日常（≤200 字、识梗、不列点）——聊天截图/表情包 | 直接用 `cfg.vision.prompt \|\| DEFAULT_VISION_PROMPT`（`service.ts:623`） |
| `'detailed'` | 详细识别（不限字数、信息密度高的图） | `DEFAULT_VISION_DETAILED_PROMPT`（`service.ts:626`） |
| `'professional'` | 专业题目（严格 LaTeX、几何坐标、反幻觉）——数理化题 | `DEFAULT_VISION_PROFESSIONAL_PROMPT` |
| `'auto'`（默认） | 先做一次轻量 4 标签分类（professional/document/casual/mixed，`maxTokens:32`）再选档；分类失败 fallback 到 detailed | `classifyAndPickPrompt`（`service.ts:682-722`） |

`auto` 会多花一次 vision 调用做分类（~1-2s）；只想要短描述（如挑图预览）时传 `'casual'` 跳过分类（`plugin-image-sender` 即如此）。

### 描述缓存（`packages/plugin-media/src/cache.ts`）

用 `@aalis/util-bounded-map`（有界 + 滑动 TTL + LRU）：`max=1000` 条、`ttlMs=24h`（`cache.ts:11-14`）。key 是 url / data-URI / 本地路径。`describeImage` 在「无 hint 且未 `noCache`」时读写缓存（`service.ts:560,651`）——**带 hint 不进缓存**（不同意图结果不同）。空串与 `[图片:` / `[动图:` 占位不写入（`cache.ts:18-19`）。`lookupDescription`/`rememberDescription` 暴露给适配器手动复用。

### storage URI 用法（provider 与调度器都要懂）

媒体处理在三种字符串间分流（`service.ts:261-291`，`cacheImageRef`）——顺序很重要：

1. `http(s)://` → 原样（下载走 `safeFetch`，见下）。
2. `isStorageUri(data)`（命中即 storage 路径，含 `data:/...`，OneBot 已落盘）→ 转相对路径 `root/rest`（`service.ts:266-269`）。
3. 否则 `data.startsWith('data:')` 当 base64 data-URI 解码、落盘到 `data:/images/{session}/{hash}.{ext}`（`service.ts:271-286`，经 `storage.writeFile`）。

⚠️ `data:/images/x.jpg`（storage 根 `data`）与 `data:image/png;base64,...`（浏览器 data-URI）只靠冒号后是否紧跟 `/` 区分——**先问 `isStorageUri` 再问 `startsWith('data:')`**，顺序反了会把 data-URI 误判成 storage 路径。完整文法见 [docs/concepts/storage-uri-grammar.md](../concepts/storage-uri-grammar.md)（§3 `data:/` vs data-URI），它直接以本服务 `service.ts:266-271` 为示例。临时帧/下载产物经 `proc.makeTempDir` + `tmp.uri` 写盘并 `cleanup`（`safe-fetch.ts:117-125`、`service.ts:505`）。

### SSRF：所有远程下载必须走 safeFetch

LLM / 用户输入触发的 URL 下载是 SSRF 高危面（`169.254.169.254`、`127.0.0.1`、`10.0.0.0/8`）。`plugin-media` 的 `safe-fetch.ts` 一律走 `safeFetch`（`@aalis/util-network-guard`，`safe-fetch.ts:12,51`），含协议/host/逐跳重定向校验 + 20 MiB 体积上限 + 15s 超时（`:16-18`），与 webui image proxy 共用同一套规则。**你写 backend 时若要自行下载远程媒体，必须用 `safeFetch`，不要裸 `fetch`**。见 [docs/concepts/security-model.md](../concepts/security-model.md)。

### authority / 隔离

`media` 服务本身不挂 authority risk/visibility 门——它是 preprocessor 链路上的内部增强，调用语境（agent / 工具）由各自的 authority 把关。但落盘路径按 `session` 做了 key 隔离（`images/{safeSession}`，`service.ts:281-282`），`buildContext` 也只读当前会话历史，provider 实现新存储路径时应延续按 session 隔离、勿跨会话泄漏。

### storage 不是沙箱

media 经 `storage` 写临时/缓存文件，但 storage 只是命名根 + 权限位，**不是进程级隔离**；ffmpeg 子进程经 `process` 服务运行同样不是沙箱。详见 [docs/services/storage.md](./storage.md) §6 与 [docs/services/process.md](./process.md)。

---

## 7. 边界与坑

- **runtime 单例依赖**：`ffmpeg.ts`/`safe-fetch.ts` 经模块级 `setMediaRuntime({proc,storage})` 注入（`runtime.ts`），在 `apply()` 时设置。若 `process`/`storage` 未启用，`getMediaRuntime()` 抛错（`runtime.ts:24-29`）——故 `inject.required:['process','storage']`（`index.ts:30`）。第三方 backend 自己拿依赖请走 `ctx`，别依赖 media 的内部 runtime。
- **audio.prefer 下拉是 live mutate 的**：`media` 监听 `service:registered/unregistered`（asr/llm）动态刷新 `configSchema.audio.fields.prefer.options`（`index.ts:322-337`）。新装 asr/audio-LLM 后选项会自动出现；这意味着 `configSchema` 对象被运行时改写，前端配置页读的是 live 对象。
- **空音频描述不归因为「非语音」**：模型空响应可能是 maxTokens 不足 / 上下文超限 / 超时，被统一标为 `[音频] 识别失败（…详见日志）`（`service.ts:397`）——别据此判断「这段音频没人声」。
- **passthrough 模式不调 processor**：`vision.mode='passthrough'` / `audio.mode='passthrough'` 时 `processMessage` 不识别，保留原始 attachment 让主模型直接吃（`service.ts:319,389`）——需主模型自身有 vision/audio 能力，否则附件等于被丢弃。
- **video.passthrough cap 与帧抽取是两条路**：`video.maxTokens`/`think`/`prompt` 只对原生视频 LLM(`video.passthrough`) 生效；默认的「抽帧→vision」路径用的是 `vision.maxTokens`（`service.ts:74-79` 注释，`index.ts:140`）。
- **缺 ffmpeg/ffprobe 时视频降级为占位**：抽帧/抽音轨失败返回 `[视频] …` 占位串而非空（`service.ts:439-441,501-502`），让主 LLM 知情有视频到达但无法读，避免幻觉。

---

## 8. 交叉链接

- 概念：[service-model](../concepts/service-model.md)（DI 按名仲裁、无 capability 选择）｜[lazy-service-access](../concepts/lazy-service-access.md)（每次 getService、别缓存）｜[manifest-metadata](../concepts/manifest-metadata.md)（provides/inject 双源）｜[storage-uri-grammar](../concepts/storage-uri-grammar.md)（`data:/` 与 data-URI 区分，直接引本服务为例）｜[security-model](../concepts/security-model.md)（SSRF / safeFetch）｜[message-llm-pipeline](../concepts/message-llm-pipeline.md)（preprocessor 在消息链路的位置）。
- 服务：[storage](./storage.md)（落盘后端，非沙箱）｜[process](./process.md)（ffmpeg 子进程）｜[llm](./llm.md)（vision/audio LLM 自动成 processor）｜[message](./message.md)（`MessageAttachment` / `IncomingMessage` 类型源）｜[agent](./agent.md)（preprocessor 注册宿主）。
- 相关契约包：`@aalis/plugin-asr-api`（音频 backend 首选契约，`packages/plugin-asr-api/src/index.ts`）。
