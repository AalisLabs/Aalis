# media 服务

`media` 把「媒体 → 文本」的多模态识别（图片描述、音频转写描述、视频抽帧加音轨）抽象成一个统一调度器。上层——agent preprocessor、工具、适配器——只需要向 `media` 提问，由它在一个 processor 池里仲裁并执行。这个池由「vision/audio LLM」与「独立的 ASR/Whisper backend」共同组成。

- **服务注册名**：`'media'`（描述符 `media`，消费方经 `media.use` 调用）。
- **契约包**：`@aalis/api-media`。契约除了服务本身，还导出底层的 `MediaProcessor` 抽象。你写「非 LLM、非音频的媒体 backend」时实现 `MediaProcessor` 再 `registerProcessor`（音频 backend 写成 `asr` provider，见 [§4](#_4-写一个-provider)）；写「服务消费」时只用 `MediaService`。
- **参考实现**：`@aalis/plugin-media`，声明 `provides=['media']`，通过 `provide.use(media, svc)` 提供，实现类是 `MediaServiceImpl`。
- **它不是沙箱**：媒体的下载与落盘走 `safeFetch`（SSRF 守卫）加 `storage`，但 storage 本身不是隔离边界，详见 [§6](#_6-能力-风险-→-影响)。

这里有两层概念需要分清。`MediaService` 是一个真实可调用的服务实例，是有运行时的服务契约。`MediaProcessor` 则是给 backend 作者实现的「插件内子契约」——它不是独立的 DI 服务，而是注册进 `media` 服务内部池子的一个处理器对象。

---

## 1. 契约：核心类型与方法签名

### `MediaService`

```ts
export interface MediaService {
  // ----- processor 池管理 -----
  registerProcessor(p: MediaProcessor): () => void;                              // 注册非音频、非 LLM 的 backend，返回注销函数
  listProcessors(cap?: MediaCapability): MediaProcessor[];

  // ----- 批量识别（按 attachment.kind 自动选 processor）-----
  describe(attachments: MessageAttachment[], opts?: DescribeOptions): Promise<Array<string | undefined>>;
  transcribe(attachment: MessageAttachment, opts?: TranscribeOptions): Promise<string | undefined>;

  // ----- 一站式：处理整条入站消息（preprocessor 与触发插件用）-----
  processMessage(msg: IncomingMessage): Promise<MediaProcessReport>;             // 把每条附件描述写进 msg._attachmentDescriptions；同一消息对象只处理一次

  // ----- 单图/单视频主动识别 + 描述缓存 -----
  describeImage(imageUrl: string, opts?: DescribeImageOptions): Promise<string>; // 带 30 天缓存；识别出错时抛出
  describeVideo(videoUrl: string, opts?: DescribeVideoOptions): Promise<string>; // 抽帧+可选音轨；失败返回空串
  lookupDescription(imageUrl: string): string | null;                            // 只查缓存不触发识别
  rememberDescriptionAlias(source: string, landedRef: string): void;    // 落盘方登记「来源 → 落盘 ref」
}
```

取服务：`media.use`；`plugin-media` 未就绪时 `media.present` 为 `false`。

### `MediaProcessor`（backend 子契约）

一个 backend 声明它能处理哪些动作，并实现对应方法。按 cap 二选一或两者都实现：

```ts
export interface MediaProcessor {
  name: string;                 // 唯一标识，建议 `<provider>:<modelOrKind>`
  capabilities: MediaCapability[];
  displayName?: string | TextRef; // UI 用
  priority?: number;            // 数值大者优先（同 cap 多 processor 仲裁），默认 0
  describe?(input: DescribeInput): Promise<DescribeResult>;    // vision/document.image/video.passthrough
  transcribe?(input: TranscribeInput): Promise<TranscribeResult>; // audio
}
```

### `MediaCapability`

四个取值，分别对应四类处理动作：

- `'vision'`：图描述，含动图抽帧整合。
- `'audio'`：音频转文本，同一个 cap 同时覆盖语音转写与音乐/环境音描述。
- `'video.passthrough'`：原生视频 LLM 直通。
- `'document.image'`：文档内嵌图的 OCR/理解。

注意 `MediaCapability` 与 LLM 的 `Capability` 语义不同：前者描述「处理动作」，后者描述「模型能力」。两者不在同一个 DI capability 体系里，详见 [§6](#_6-能力-风险-→-影响)。

### 输入/输出类型

- **`DescribeInput`**：`attachments`，加上 `basePrompt`（完整替换默认 base）/ `hint`（在 base+context 之后追加一条约束）/ `context`（对话上下文，processor 可拼进 prompt）/ `maxTokens` / `mode:'single'|'combined'` / `sessionId`（附件所在的会话，LLM processor 把它带进模型请求供记账；不在会话里识别时不填）/ `signal`（中止信号，LLM processor 把它带进模型请求，中止时识别随之停下）。
  - `basePrompt` 与 `hint` 的语义严格分离：要换整段 prompt 用 `basePrompt`，只加一条要求用 `hint`。把整段 prompt 放入 `hint` 会与默认 base 冲突。
- **`DescribeResult`**：`descriptions`（`mode=single` 时与 `attachments` 等长；`mode=combined` 时是单元素），加上 `meta?:{processor,model?,tokens?}`。
- **`TranscribeInput`**：单条 `attachment`，加上 `language?`（ISO 639-1）/ `withTimestamps?`（后端可忽略：第一方只有经 asr 桥接的 plugin-asr-openai 返回 `segments`，音频 LLM 与 plugin-asr-whisper-cpp 只给整段 `text`）/ `context?`（仅对 LLM-as-audio 有意义，传统 Whisper 忽略）/ `sessionId?`（音频所在的会话，音频 LLM 把它带进模型请求供记账；不在会话里转写时不填）/ `signal?`（中止信号，交给转写前的转码与转写，中止时转写随之停下；没给时内置处理器接 media 这次激活的）。
- **`TranscribeResult`**：`text` / `segments?` / `language?` / `meta?:{processor,model?}`。
- **服务层 opts**：`DescribeImageOptions`（含 `detailLevel` 档位，详见 [§6](#_6-能力-风险-→-影响)；`sessionId` 是图片所在的会话，识别按它记账；`signal` 让网址来源的下载随之停下，并经 `DescribeInput.signal` 交给识别的模型调用，`analyze_image` 传执行器给这次调用的信号）、`DescribeVideoOptions`（`hint` / `localPath`）、`DescribeOptions`（含 `prefer`，强制选定 processor）、`TranscribeOptions`（`language`；音频 processor 由配置 `audio.prefer` 选定）；后三者的 `signal` 与 media 这次激活的合并，交给下载、抽帧、转写与识图。
- **`MediaProcessReport`**：`{ total, successCount, items[] }`，`items` 与 `msg.attachments` 等长，每条含 `{kind,cap?,processor?,description?,error?}`。

### 事件（declaration merging）

`'media:processed': [{ sessionId, report }]`。一条入站消息的所有附件处理完毕后发出，无论成功还是失败都会发，供 webui、archive、调试等消费。

### 会话媒体的目录约定

会话里收发与产生的媒体（适配器落盘的附件、上传的图片、绘图产物）按种类与会话分目录，每个写入方用自己的子目录：

```
data:/<种类目录>/<会话目录>/<写入方>/<文件>
```

契约包导出这组约定，纯函数，media 缺席时也能用：

```ts
const MEDIA_KIND_DIRS: Readonly<Record<'image' | 'audio' | 'video' | 'file', string>>; // data:/images 等
function sessionDirName(sessionId: string): string;                                   // 会话 id → 会话目录名
function sessionMediaUri(kind, sessionId: string, writer: string): string;             // 写入方在这个会话里这种媒体的目录
function clearSessionMedia(storage, kind, writer: string, sessionId?: string): Promise<number>;
```

- **会话目录名**：`sessionDirName` 把会话 id 里的 `:`、`/`、`\`、`..` 与前导点换成 `_`，空 id 抛错（工具调用上下文的 `sessionId` 必填，空的是调用方的缺陷）。换法有损：会话 id 不能只在这几处有区别（`x:a_b` 与 `x:a:b` 落进同一个目录），大小写不敏感的卷上只差大小写的也落进同一个目录。
- **写入方**：第一方有三家，onebot（收发的图片、语音、视频、文件）、media（上传的图片）、draw（绘图产物）；第三方写入方用自己的名字作子目录，经 `sessionMediaUri` 取目录。附件引用（存档的附件清单、正文里的 `[图片 | ref:…]`、发出的附件）一律写完整的存储地址，不写相对路径。
- **命名约定**：按内容寻址的写入方把文件名写成内容 SHA-256 的前 16 位小写十六进制加扩展名（onebot、media 是这样），描述缓存据此让不带会话语境的描述跨会话复用（见[描述缓存](#描述缓存)）；文件名不是这种写法的（如绘图产物）按存储地址各存一条。
- **谁清**：谁写的谁清。写入方经贡献点 `memory:clear-type` 登记它写的种类（`/clear -t` 只认登记了的类型，几家登记同一种类时帮助里只列一次），挂 `memory:clear` 中间件，所选类型含它写的种类时调 `clearSessionMedia` 清自己的子目录：给会话时只删这个会话的，不给时删各会话的，回删掉的文件数，要删的不在时回 0，其余存储错误照抛。会话目录删空了一并删掉，别的写入方的子目录不动。每种一行结果、标 `type`，会话级与全局清理用同一句、写删掉的文件数，存储不在时不出结果行。`/clear` 与删除会话都走这一条，不装指令插件时删会话也清附件。浏览器截图落在 `tmp:/browser/<会话目录>/`（同一个 `sessionDirName`），不进 `/clear`。

### 媒体判据

契约包另导出一组纯函数，判一次调用能取哪些存储里的媒体。`send_attachment`、`analyze_image` 与 plugin-image-sender 的出站转换共用它；它不是 `media` 服务的方法，media 缺席时也能判。

```ts
function mediaScopeOf( // 第一方的判据：交出这次调用判 target 的函数
  call: MediaScopeCall & { approveFor(check: (who: UserIdentity) => Verdict): Promise<Verdict> }, // 取用判定，工具交工具调用上下文的
  services: {
    sessionManager: Pick<ServiceSelection<SessionManagerService>, 'present' | 'use'>; // 照插件拿到的服务选择给
    authority: Pick<ServiceSelection<AuthorityService>, 'present' | 'use'>;
    history: MediaScopeDeps['history'];
  },
): (target: string) => Promise<boolean>;
function mediaInScope(target: string, call: Pick<MediaScopeCall, 'sessionId'>, deps: MediaScopeDeps): Promise<boolean>;
function localFileInScope(call: MediaScopeCall, deps: LocalFileDeps): boolean; // 本机文件判法
function mediaRef(input: string): string | undefined;          // 网址原样；存储地址规整；相对路径等不收
function historyMediaRefs(messages: readonly Message[]): string[]; // 历史里系统记下的媒体引用

/** 一次调用，字段同工具调用上下文 */
interface MediaScopeCall {
  sessionId: string;
  platform?: string;
  participants: readonly UserIdentity[]; // 这一轮的参与者（授权身份）；认不出这一轮的出站（不是回合里的回复）为空
  inbound?: InboundTurn; // api-authority 的入站回合，本机文件判法据它取这一轮的主体
}
/** 由调用方按这一次调用给 */
interface MediaScopeDeps {
  sessions?: Pick<SessionManagerService, 'getSession' | 'listSessions'>; // 会话管理在场才给
  take: (sessionIds: readonly string[]) => Promise<boolean>; // 别的会话的媒体：这几个会话都能不能取
  local: () => Promise<boolean>; // 不在任何会话媒体目录下的本机文件能不能取
  history: (sessionId: string) => Promise<readonly Message[]>; // 记忆不在时为空；第一方取最近 200 条
}
interface LocalFileDeps {
  principalOf: (call: MediaScopeCall) => 'owner' | 'other'; // 权限服务的 principalOf，不在时恒为 other
  isOwner: (platform: string, userId: string) => boolean; // 权限服务不在时恒为否
  sessions?: Pick<SessionManagerService, 'getSession'>; // 会话管理在场才给
}
```

- **判法**：按目标分三类，只回能或不能。种类目录（`images`、`browser` 等）与反查的目录名按大小写折叠比：只差大小写或折叠后相同（如 `ſ` 与 `s`）的写法在大小写不敏感的卷上是同一个目录，`data:/Images/<目录>/…` 与 `data:/images/<目录>/…` 分在同一类，不当本机文件。
  会话媒体目录（`data:/{images,audios,videos,files}/<会话目录>/` 与 `tmp:/browser/<会话目录>/`）里的文件按目录名在本会话树（根会话加它的全部子会话）与会话表里反查会话。目录名有损，几个会话撞同一个目录时取并集。会话管理不在时会话树只有调用所在会话自己，也没有会话表可查。
  1. 反查出的会话都在本会话树里，或等于调用所在会话历史里系统记下的引用：放行，不问 `take` 与 `local`。先比目录，不中再读历史。
  2. 反查出本会话树以外的会话（与本会话树的目录撞名的也算）：`take` 判这些会话都能取才放行，本会话树的不问。一个会话都反查不到（会话已删）时不能取。
  3. 不在任何会话媒体目录下的本机文件（工作区、下载等）：按 `local`，调用所在会话历史里记过的也一样（owner 发进群的工作区截图，群友之后不能借历史让她再发）：本机文件按地址取到的是此刻的内容，不一定是当初收发的那份。
- **第一方的判据**：两个工具与出站转换按这一次调用调 `mediaScopeOf`，两样判定都按一个授权身份：`take` 是每个候选都过会话管理的取用规则（api-session-manager 的 `takeFrom`，当前会话是调用所在会话；规则见 [session-manager 服务](./session-manager.md#_2-8-取别的会话的东西)），对所有人一样，owner 也不例外；`local` 是只有这一位参与者时的 `localFileInScope`：这一轮的主体是 owner（权限服务的 `principalOf`：owner 亲手、参与者都是 owner 的那一轮，含它的续做与它派的子任务），或唯一的参与者是 owner、所在会话的房间类别（api-session-manager 的 `roomClass`）不是 room（非人回合的条款，如 owner 自己会话里的定时任务、按 owner 跑的编排、mcp-server 的调用；会话管理不在时不放行）。两样判定都交给调用方给的取用判定 `approveFor`：工具交它的工具调用上下文，逐个参与者判：都过照常取，有人过不了时发一道参与者审批，能批的是过得了的人（某个参与者自己的私聊由他本人批，本机文件由 owner 批），都过不了取不到（见 [api-tools](../api/api-tools.md#toolcallcontext)）。没有可挂审批的调用的（回复里的标记）交只按一个授权身份判的，plugin-image-sender 取 api-tools 的 `actingIdentity`：几个人或没有授权身份时是无主体，取不到谁自己的私聊与本机文件。自己写取存储媒体的工具也用 `mediaScopeOf`，交它的工具调用上下文。
- **历史引用**：`historyMediaRefs` 只读结构化字段，即入站附件清单（metadata 的 `Attachments` 各项的 `ref`）与发出的附件（`SentRef`），不读正文里的 `[图片 | ref:…]`：群友能打出伪造的占位符。目录按整棵会话树比，历史只取调用所在会话；历史只放行会话媒体目录里的，本机文件照第 3 条。
- **规整**：`mediaRef` 消 `.`、`..`，带反斜杠的不收（有的系统按目录分隔解析它），盘符路径（`C:/…`）按本机路径不收，相对路径（`data/images/…`）不是存储地址、不收；网址按 api-storage 的 `isWebUrl` 认（`http://`、`https://`，协议名不分大小写），原样交出。判据先规整 target，调用方读的也应是规整后的那个。
- **出站转换**：plugin-image-sender 在 `outbound:dispatch` 上处理带 `markup` 的正文（她的回复）里存储地址的 `<image|video|record url="…"/>`（`mediaRef` 规整出存储地址的，`base64://…` 也按根名 base64 的存储地址算）：与两个工具同一份判据，按回复所在的那一轮判：在 `agent:turn:before` 按回合 id 记下这一轮输入的引用（插进来的输入会追加上去），回复按它的 `turnId` 取回，用那时的输入经 api-authority 的 `originTurnOf` 拼出这一轮（会话取出站的目标会话，取用范围按它判）交给 `mediaScopeOf`，授权身份取 `actingIdentity`：只有一位参与者时按他判（别的会话的按会话管理的取用规则，某人自己的私聊只在他那一轮转；本机文件按主体或非人回合的条款），几个人时不带授权身份（别人的私聊与本机文件都不转），回复里的标记不出审批；认不出这一轮的出站（不是回合里的回复）只带会话、不带授权身份判。受众只有 owner 的会话同样过判据。再与 `send_attachment` 一样按文件头核对，都过了的摘出来转成同类附件，送达之后与别的附件一样由 message-archive 记进会话历史。只摘掉转成了附件的标记：不过判据的、读不出的（如 `base64://…`）与不是对应媒体的，和别的写法（网址、`file://`、本机路径、data URI 等）一样留在正文里交给适配器：onebot 只发网址的，下载、核对文件头后内联，其余去掉并报投递失败（见 [onebot 适配器的「出站正文」](../plugins/plugin-adapter-onebot.md#出站正文)）；WebUI 与终端不解析标记，按原文显示。摘掉标记后两边的文字拼成的新标记同样留给适配器，它在解析出的消息段上判。没装 plugin-image-sender 时她回复里的存储媒体发不出。
- **会话目录名**：判据与写入方用同一个 `sessionDirName`（见上节），按目录的第二段比对；写入方的子目录在会话目录之下，判据不看它。新的写入方经 `sessionMediaUri` 把会话媒体写进这几个目录，才算这个会话的媒体。

判据按目录约定判归属，不是隔离，见 [安全模型的「媒体工具的取用范围」](../concepts/security-model.md#媒体工具的取用范围)。

---

## 2. 谁提供 / 谁消费

### 提供方

| 包 | 角色 |
| --- | --- |
| `@aalis/plugin-media` | 唯一的 `media` 服务提供者兼调度器。内置 LLM-as-Processor adapter，自动把所有在 `capabilities` 里声明了 vision/audio 的 LLM 包成 `MediaProcessor`（name 格式 `llm:${contextId}#${cap}`，cap 为 vision 或 audio）；同时把核心 `asr` 服务的每个 provider 桥接成 cap=`audio` 的 processor（name 格式 `asr:${contextId}`）。 |
| `@aalis/plugin-asr-whisper-cpp` / `@aalis/plugin-asr-openai` | 不直接 provide `media`，而是 provide 核心 `asr` 服务（`subsystem='media'`）。media 会自动把它们纳入 audio 池。写一个音频 backend 时应优先写成 `asr` provider，而非 `MediaProcessor`，见 [§4](#_4-写一个-provider)。 |

### 典型消费点

| 包 | 调用 | 说明 |
| --- | --- | --- |
| `plugin-media`（自身 preprocessor） | `svc.processMessage(msg)` | 经 `buildPreprocessor` 注册到 agent |
| `plugin-trigger-laya`（私有）判定前等附件识别 | 先看 `media.present`，再 `media.use.processMessage(msg)` | 模型判定前提前识别（有等待上限）；之后预处理器与归档不再识别第二遍 |
| `plugin-file-reader` | `media.use.describeImage(uri)` | 识别 DOCX 内嵌图；先取 `media.present ? media.use : undefined`，再判 `if (!mediaService?.describeImage) return ''` |
| `plugin-image-sender` | `media.use.describeImage(url, { detailLevel: 'casual' })` | 给候选图打描述以挑图 |
| `plugin-adapter-onebot` | `media.use.lookupDescription(url)` | 只复用缓存、不触发识别 |
| `plugin-message-archive` | `media.present` → `media.use` | 归档入站时取描述（消息尚无 `_attachmentDescriptions` 时才识别）；她发出的网址图片与视频记进历史之后，在后台调 `describeImage` / `describeVideo` 补描述（见 [plugin-message-archive](../plugins/plugin-message-archive.md)）；`uses optional:['media']` |
| `plugin-agent` | `media.present` | 探测 media 是否在场：在场时当轮图片原样透传，缺席时自行兜底翻译 |

---

## 3. 服务模型背景

有三条前提对使用 `media` 是必要的：

- DI 按**名字**解析，每个消费方只选中一家 `media`：本插件偏好 > 全局偏好 > priority > 位次。0.5.0 起**没有** capability-based 的服务选择——capability 概念活在 `MediaProcessor.capabilities`（实例内部池）里，不是 DI 的选择维度。见 [docs/concepts/service-model.md](../concepts/service-model.md)。
- 业务句柄 **`media.use` 是活的**，选择、缺席与固定同一家的规则见 [选择层与业务层](../core/context.md#选择层与业务层)。
- manifest 的双源（`package.json` 里的 `aalis.service` 与模块导出的 `provides`/`uses`）需要保持一致。见 [docs/concepts/manifest-metadata.md](../concepts/manifest-metadata.md)。

---

## 4. 写一个 provider

先决定走哪条路：

| 你的 backend 是… | 怎么接入 |
| --- | --- |
| **vision / audio 的 LLM** | 什么都不用做。只要你的 LLM provider 在 `capabilities` 里声明了 vision/audio，`plugin-media` 的内置 adapter 会懒扫描并自动把它包成 `MediaProcessor`。 |
| **音频转写 backend**（whisper / 云 ASR） | 写成 `asr` provider，实现 `ASRService`（`@aalis/api-asr`，单方法 `transcribe`）。media 会自动把它桥接进 audio 池。可参考 `plugin-asr-whisper-cpp`。这是首选做法——它能同时被「直接消费 `asr`」与「经 media 调度」两条路用到。 |
| **非 LLM 的图/视频 backend**（如自建 OCR、专用识别服务） | 实现 `MediaProcessor`，在 `media.follow` 里 `registerProcessor(p)`（随提供者换人重挂）。 |

### 4a. 不要重新 provide `media` 服务

`media` 调度器只应有一个实现（`plugin-media`）。你**不要** `provide.use(media, ...)`——那会和官方调度器争抢同名服务，消费方选中哪一家随之不定。你要做的是往现有调度器里**注册 processor**，或者**写一个 `asr` provider**。

### 4b. 注册一个 `MediaProcessor`（非 LLM backend 骨架）

```ts
import { media } from '@aalis/api-media';
import type { DescribeInput, DescribeResult } from '@aalis/api-media';
import { definePlugin } from '@aalis/core';

export default definePlugin({
  name: '@aalis/plugin-my-ocr',
  uses: { media },
  apply({ media }) {
    // 处理器登记在 media 提供者的池里：用 follow 随提供者换人重挂，返回的注销函数在换人、下线与关闭时执行
    media.follow(svc =>
      svc.registerProcessor({
        name: 'my-ocr:default',
        capabilities: ['vision'],
        displayName: '自建 OCR',
        priority: 10,
        async describe(input: DescribeInput): Promise<DescribeResult> {
          return {
            descriptions: input.attachments.map(() => ''),
            meta: { processor: 'my-ocr:default' },
          };
        },
      }),
    );
  },
});
```

### 4c. 写一个 `asr` provider（音频 backend 首选骨架）

```ts
import { asr } from '@aalis/api-asr';
import type { ASRService } from '@aalis/api-asr';
import { definePlugin, provide } from '@aalis/core';

export default definePlugin({
  name: '@aalis/plugin-asr-xxx',
  subsystem: 'media',
  provides: [asr],
  uses: { provide },
  apply({ provide }) {
    const impl: ASRService = {
      async transcribe(input) {
        return { text: '', language: input.language, meta: { model: 'whisper-xxx' } };
      },
    };
    provide.use(asr, impl, { priority: 0 });
  },
});
```

任一 provider 都要同步 `package.json` 的双源：

```jsonc
{
  "aalis": { "service": { "provides": ["asr"], "required": ["process", "storage"] } },
  "keywords": ["aalis", "aalis-plugin"]
}
```

契约包本身（`api-media`）的 `keywords` 是 `["aalis","aalis-api"]`——契约包不打 `aalis-plugin` 词，不会被当作插件加载。

---

## 5. 标准消费写法

```ts
import { media } from '@aalis/api-media';
import { definePlugin, optional } from '@aalis/core';

export default definePlugin({
  name: '@aalis/plugin-my-feature',
  uses: { media: optional(media) },  // media 是可选增强时
  apply({ media }) {
    async function describe(url: string): Promise<string> {
      const svc = media.present ? media.use : undefined;  // 可选依赖先看 present
      if (!svc?.describeImage) return '未启用 media 服务';  // 服务缺失 / 方法缺失双重保护
      try {
        // 无可用识别器或结果为空时返回空串；识别出错时抛出
        const desc = await svc.describeImage(url, { detailLevel: 'casual', hint: '挑出有猫的图' });
        return desc || '（识别失败）';
      } catch {
        return '（识别失败）';
      }
    }
    // …把 describe 接到工具或命令上
  },
});
```

几个要点：

- **先看 `present`**：`plugin-message-archive`、`plugin-image-sender`、`plugin-file-reader` 都是先取 `media.present ? media.use : undefined`，再加 `if (!svc?.xxx)` 守卫，对照见 [§2](#_2-谁提供-谁消费)。
- **只复用缓存、不触发识别**：对引用消息里的图，OneBot 适配器只调 `lookupDescription(url)`，未命中就保持 `[图片]` 占位，不会主动消耗 vision token。
- **错误边界**：`describe`/`transcribe`/`describeVideo` 内部做了 try/catch，失败返回 `undefined` 或空串而非抛错，调用方按「空 = 降级」处理即可；例外是中止的转写（调用方给的 `signal` 断开，或 media 停用、停机），`transcribe` 抛中止原因，不当成转不出。`describeImage` 不同：没有可用的 vision processor 或识别结果为空时返回空串，动图抽不出帧时按整图识别；识别过程出错（识别模型调用失败、图取不到等）时直接抛出，调用方需自行 try/catch。
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

缓存基于 `@aalis/util-bounded-map`（有界，加滑动 TTL，加 LRU），配置为 `max=5000` 条、`ttlMs=30 天`（图片内容不变、描述也就不过期，长留才用得上跨天的表情包复用）。值只存裸描述，ref 标记等包装由各消费点重建。键按来源取：

- **存储地址**：不带会话语境、文件名按[命名约定](#会话媒体的目录约定)是内容哈希的，以哈希为键，跨会话复用；带会话语境的（开启 `contextHistory` 后识别出的）与文件名不是内容哈希的（如绘图产物），以存储地址为键，只在本会话命中。只认存储地址，不要求落在会话媒体目录；网址不按文件名认（图床直链也有这种文件名）。
- **网址**：原样做键；落盘方登记的别名把它落到落盘地址的键上（见下文「来源 → 落盘 ref 别名」）。
- **data URI**：原样做键；media 落盘后登记别名，同上。

**快照与清理**：缓存防抖落盘到 `data:/media/descriptions.json`，启动时灌回。本插件这次激活关掉时落盘一次，之后晚到的描述只进内存、不再排落盘，下一次激活灌回时重新开落盘，关掉之前发起的灌回读完时不开（缓存是模块级共享的，不由已关掉的激活写快照）。快照收落盘的两种键：内容哈希键（不带会话语境的描述，跨会话共享），以及存储地址键（带会话语境的描述，`senderContext` 只随 `contextHistory` 并入语境、单独开启不产生这类键；文件名不是内容哈希的描述）；网址与 data-URI 做键的条目不落盘。本插件参与 `memory:clear`，按所选类型清理，图片、视频各回一行、各标 `type`：`describeVideo` 写入的视频描述归 `video` 类型（键带 `#video` 后缀），其余描述（静态图、动图）归 `image` 类型；别名按落盘地址所在的种类目录归类，视频目录下的归 `video`。`/clear all` 清空所选类型的内存条目与别名，两类都清时删掉快照文件，只清一类时重写快照、另一类留在其中；会话级 `/clear` 与删除会话只删键与别名以 `data:/<种类目录>/<会话目录>/` 开头的（不论哪家写的，绘图产物的描述也在内），删掉了条目时重写快照。内容哈希键跨会话共享、无法归属到某个会话，会话级清理不删；视频描述不带会话语境、以内容哈希为键，会话级清理删不到。同一个 `memory:clear` 里本插件另清自己写的上传图片（见[会话媒体的目录约定](#会话媒体的目录约定)）。启动时读快照失败（文件不存在以外的原因）的那次运行不写快照，此时会话级清理只能清内存，回执报失败；`/clear all` 照样删掉快照文件（只清一类时也整份删掉，读不出旧快照就无从只删一类），此后本次运行的会话级清理不再报失败（磁盘上已没有会在重启时恢复的描述）。描述清理排到时本插件这次激活已开始关闭的（清理途中关掉，或关闭途中才进来的清理）不清，回执报失败并带上原因：关闭要停掉落盘，之后的清理改写不了快照。

**来源 → 落盘 ref 别名**：网址与 data URI 本身不是存储地址，落盘后才有存储地址。落盘方在落盘成功时登记一次「来源 → 落盘 ref」别名——本服务的 `cacheImageRef` 落 base64 data-URI 时自登记，服务外的落盘方（适配器把 QQ 媒体直链落到 `data:/images/<会话目录>/onebot/…`）经 `rememberDescriptionAlias(source, landedRef)` 登记。此后按原始来源串读写描述都落到落盘地址的那条键上——**OneBot 引用消息只拿得到原始 URL**（适配器那条路径只查缓存、不主动触发识别）时经此命中，同一张图换来源进来也不重认，描述还进得了快照（快照不收原始来源串做键，见上段）。别名按来源串相等命中；QQ 直链里的 rkey 是访问密钥，定期轮换但不改变文件，适配器登记时同时登记剥掉 rkey 的键，引用消息查询时也按剥掉 rkey 的键再查一次，轮换后仍命中。带会话语境的描述按原始来源查不到（键是落盘的存储地址，只在本会话命中）。别名表纯派生、不落盘，重启后由新一轮落盘重新登记；键空间不变，别名只把来源映到落盘地址的键。登记之前已按原始来源串写入的条目不迁移（窄场景，代价只是多识别一次）。

`describeImage` 只在「无 hint 且未 `noCache`」时读写缓存——**带 hint 不进缓存**，因为不同意图的结果不同。缓存按详略档分键：`'auto'`（默认）与到达识别共用同一条，`casual` / `detailed` / `professional` 各自一条（否则「详细分析」会直接命中到达时写下的简述）；档位后缀加在内容哈希之后，别名与跨会话共享对各档同样生效，快照也一并落盘。空串不写入；视频取不到、抽不出帧时写进描述位的失败说明也不写入，下次照样重试。`lookupDescription`/`rememberDescriptionAlias` 则暴露给适配器做手动复用与别名登记。

### storage URI 用法（provider 与调度器都要懂）

内部的 `cacheImageRef` 在三种字符串形态间分流，顺序很重要：

1. `http(s)://` → 原样保留（下载走 `safeFetch`，见下）。
2. `isStorageUri(data)` 命中（即 storage 路径，含 `data:/...`，适配器已落盘）→ 原样保留。
3. 否则若是 base64 data-URI，解码后经 `storage.writeFile` 落盘到本插件的子目录 `data:/images/<会话目录>/media/<hash>.<ext>`，并登记上节的「来源 → 落盘 ref」描述缓存别名。

落盘后的引用写进描述位；正文里已有这个引用的（适配器落盘后按消息段写下了引用）不再重复写。第 3 种落了盘的，地址另写在附件的 `ref` 上，message-archive 的附件清单按它记（不读描述）。

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

不过落盘路径按会话分目录（`data:/images/<会话目录>/media/`），识别时拼的对话上下文也只读当前会话历史。`analyze_image` 读存储里的图之前过[媒体判据](#媒体判据)，读出后按文件头认格式，不是图片的拒绝。provider 实现新的存储路径时，应延续按 session 隔离，不要跨会话泄漏。

### storage 不是沙箱

media 经 `storage` 写临时/缓存文件，但 storage 只是命名根加权限位，**不是进程级隔离**；ffmpeg 子进程经 `process` 服务运行，同样不是沙箱。详见 [docs/services/storage.md](./storage.md) §6 与 [docs/services/process.md](./process.md)。

---

## 7. 边界与注意事项

- **runtime 单例依赖**：media 内部的 ffmpeg 与远程下载逻辑经模块级 `setMediaRuntime({proc,storage})` 注入依赖，在 `apply()` 时设置。若 `process`/`storage` 未启用，`getMediaRuntime()` 会抛错——因此 `uses required:['process','storage']`。第三方 backend 若要自己拿依赖，请在 `uses` 里声明 `process` / `storage`，不要依赖 media 的内部 runtime。
- **audio.prefer 下拉是 live mutate 的**：`media` 经 asr 与 llm 选择层的 `watch` 在它们的提供者可能变了时动态刷新 `configSchema.audio.fields.prefer.options`。新装 asr 或 audio-LLM 后，选项会自动出现。这意味着 `configSchema` 对象在运行时被改写，前端配置页读的是这个 live 对象。
- **空音频描述不等于「非语音」**：模型的空响应统一标为 `[音频] 识别失败（…详见日志）`，为什么空看日志里的结束原因（`finish=`）与输出用量。不要据此判断「这段音频没人声」。
- **输出上限只防失控**：LLM processor 的识图（`vision.maxTokens`）与转写（`audio.maxTokens`，思考与正文共用）默认都是 2048，明显高于提示词要的长度，提示词里的字数要求是软的。模型在上限处停下（模型插件报的结束原因 `finishReason` 是 `length`）时，描述与转写末尾带「（已在长度上限处截断）」，不重试、不按字数再截，写进正文与描述缓存的都是带标记的这一句。标记目前按原文语言，与识图提示词一致。
- **图片是「识别模型 + 两个正交开关」**：`vision.prefer` 是识别模型；`vision.recognizeOnArrival`（默认开）决定图片到达是否立即识别落描述——描述进档案与向量库、可被召回，被吞掉的消息也留记忆；关掉则档案只留指针 `[图片 | ref:…]`，主模型需要时经 `analyze_image` 按需看，代价是图片内容不可被检索召回。`vision.delivery` 决定主模型需要看图（当轮附件、`analyze_image`）时怎么给：`auto`（默认）按 agent 交来的 `acceptsImages`（`agent:llm:before` 与工具上下文的，agent 按这一轮的模型在模型服务登记的能力填）——能看图则直通原图，不能看则由识别模型转文字，media 自己不查模型能力。端点没报告视觉能力的模型（如经中转站接入的）要直接看图，在模型服务的「单模型能力覆盖」（`modelCapabilities`）里给它写上 `vision`。也可显式钉死 `passthrough`/`describe`：钉死 `passthrough` 时当轮附件照样交给不能看图的模型，`analyze_image` 在不能看图的会话里仍走识别模型（结果里的图交不到模型）。`audio.mode='passthrough'` 仍是音频直通：不转写，保留原始 attachment 让主模型直接接收（需主模型 audio 能力）。
- **没有能看图的模型时图照样存下**：到达识别找不到能描述图片的识图处理器时，每张图只落盘写成不带描述的引用，这条消息另加一行 `[附了 N 张图，当前无法查看]`，不留空气泡、原图不丢；识别失败或返回空串的，引用照留、描述写「获取或识别失败，内容未知」。plugin-media 同时向 doctor 报 `service/media.vision` 警告。
- **describe 交付不向主模型交图**：识别是识别模型的职责，结果已作为文字拼进消息正文，出口会把这一轮各条 user 消息的 `images` 清空。再把原图递一份给主模型等于同一张图识别两遍——实测一张 57KB 的图额外多花约 1,090 token、4.7 秒预填充。`analyze_image` 在这条交付下返回文字描述。
- **passthrough 交付的动图一律抽帧**：出口（`agent:llm:before` 中间件）把动图抽帧为多张静图（帧数上限 `animatedImage.maxFrames`）再交给主模型——主流视觉 API 对原始 GIF 只读首帧或拒收，抽帧是让"动"被看见的唯一通用形态。是不是动图按来源的字节判：视频容器，或多帧的 GIF、APNG、动态 WebP；单帧 GIF 按静图。网址来源的先下载下来判；静图按读到的字节转成 data URL 交出，类型取判定结果，读不到字节的照原样规范化。变换作用于这一轮各条带图的 user 消息（agent 只给这一轮的输入挂图，历史消息不带图），每条消息只处理一次（成败皆不重来），dryRun 估算轮跳过。`analyze_image` 在这条交付下把图随工具结果交出（`ToolExecutionResult.images`，同一出口规范化与抽帧），不经识别模型。
- **直通必须过形态规范化**：适配器给 `attachment.data` 的是落盘的存储地址（`data:/images/…`），而 provider 只认 data URI / http / `file://` / 绝对路径。存储地址原样交出会被当作 base64 送出去，触发 `illegal base64 data at input byte N`（整轮请求 400）。出口统一物化成 data URL，已是合法形态的逐字节原样；交不出合法形态的那一张丢弃并告警。
- **描述缓存跨会话共享是有条件的**：缓存键取落盘文件名里的内容哈希，同一张表情包跨群只识别一次；但当 `contextHistory` 开启、描述里掺进了本会话的对话语境（`senderContext` 开启时还有发送者画像）时，键退回含会话目录的存储地址，只在本会话内复用——否则 A 群的语境会随描述串到 B 群。缓存有快照落盘（`data:/media/descriptions.json`），进程重启不必重认。
- **视频只有「抽帧 → vision」一条路**：media 不再为声明 Video 能力的 LLM 注册 `video.passthrough` processor（service 从不按该 cap 选 processor），抽帧描述用的是 `vision.maxTokens`。`MediaCapability` 里保留该 cap 只为第三方 processor 契约兼容。
- **缺 ffmpeg/ffprobe 时视频降级为占位**：抽帧或抽音轨失败时返回 `[视频] …` 占位串而非空串，让主 LLM 知道有视频到达但读不了，避免幻觉。

---

## 8. 交叉链接

- 概念：[service-model](../concepts/service-model.md)（DI 按名仲裁、无 capability 选择）｜[lazy-service-access](../concepts/lazy-service-access.md)（业务句柄是活的）｜[manifest-metadata](../concepts/manifest-metadata.md)（aalis.service 与 definePlugin provides/uses 双源）｜[storage-uri-grammar](../concepts/storage-uri-grammar.md)（`data:/` 与 data-URI 区分，直接引本服务为例）｜[security-model](../concepts/security-model.md)（SSRF / safeFetch）｜[message-llm-pipeline](../concepts/message-llm-pipeline.md)（preprocessor 在消息链路的位置）。
- 服务：[storage](./storage.md)（落盘后端，非沙箱）｜[process](./process.md)（ffmpeg 子进程）｜[llm](./llm.md)（vision/audio LLM 自动成 processor）｜[message](./message.md)（`MessageAttachment` / `IncomingMessage` 类型源）｜[agent](./agent.md)（preprocessor 注册宿主）。
- 相关契约包：`@aalis/api-asr`（音频 backend 首选契约）。
