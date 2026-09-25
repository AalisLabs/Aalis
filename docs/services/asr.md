# asr 语音识别服务

把「单条音频附件 → 文本」抽象成核心可替换服务。消费方用 `asr.current` 拿到当前胜出的后端（whisper.cpp / 云 ASR / 兼容 OpenAI 的网关），无需感知具体实现。

- 服务注册名：`'asr'`（`asr.current`）
- 契约包：`@aalis/api-asr`（`packages/api-asr/src/index.ts`）
- 参考实现：`@aalis/plugin-asr-openai`、`@aalis/plugin-asr-whisper-cpp`
- 典型消费方：`@aalis/plugin-media`（把每个 asr provider 包成 `cap='audio'` 的 MediaProcessor）

---

## 1. 契约

`@aalis/api-asr` 只导出**类型 + 一个接口 + 服务描述符 `asr`（`defineService`）**，自身不注册任何运行时服务。

服务接口（`packages/api-asr/src/index.ts`）：

```ts
export interface ASRService {
  transcribe(input: TranscribeInput): Promise<TranscribeResult>;
}
```

入参（`index.ts`）：

```ts
export interface TranscribeInput {
  attachment: MessageAttachment;          // 单条音频 attachment
  language?: string;                      // ISO 639-1，如 'zh'/'en'；不填由后端自检
  withTimestamps?: boolean;               // 是否需要时间戳分段
  context?: string;                       // 仅 LLM-as-audio 后端有意义；传统 Whisper 忽略
}
```

出参（`index.ts`）：

```ts
export interface TranscribeResult {
  text: string;                                                  // 完整文本
  segments?: Array<{ start: number; end: number; text: string }>; // 分段（后端提供则填）
  language?: string;                                             // 检测到的语种
  meta?: { processor?: string; model?: string };
}
```

输入的 `attachment.data` 是一个字符串，约定承载多种来源（`packages/schema-message/src/index.ts`）：base64 data URL / `http(s)://` URL / `file://` URI / storage URI（`<root>:/path`）。provider 负责把它物化成可读字节，下文「写一个 provider」详述。

经 `defineService` 描述符 `asr` 取得强类型（`index.ts`）：`asr.current` 为 `ASRService | undefined`，无可用后端时即为 `undefined`。

---

## 2. 谁提供 / 谁消费

### Provider（两个参考实现）

| 包 | 后端 | uses | 默认 priority |
|---|---|---|---|
| `@aalis/plugin-asr-openai` | OpenAI 兼容 `/audio/transcriptions`（OpenAI / Groq / 本地网关） | `optional: ['process','storage']`（`plugin-asr-openai/src/index.ts`） | 50 |
| `@aalis/plugin-asr-whisper-cpp` | 本地 `whisper-cli` 二进制 + ffmpeg 转码 | `required: ['process','storage']`（`plugin-asr-whisper-cpp/src/index.ts`） | 80 |

两者都 `provides: [asr]`，都在 `apply` 内 `provide(asr, asr, { priority })` 注册（`plugin-asr-openai/src/index.ts`；`plugin-asr-whisper-cpp/src/index.ts`）。

`uses` 一个 optional 一个 required 的原因：openai 后端只在「附件是本地路径/storage URI」时才需要 process/storage（base64/http 自带数据），所以可选；whisper-cpp 永远要落临时文件并跑 ffmpeg/whisper-cli，process/storage 是硬依赖。

### Consumer（标准消费点）

唯一的内置消费方是 `@aalis/plugin-media`。它把 `asr` 声明为可选依赖（`plugin-media/src/index.ts` 的 `uses` 里 `asr: optional(asr)`），并在 `MediaServiceImpl.asrProcessors()` 里把**每个** asr provider 包成 `cap='audio'` 的 MediaProcessor，与「具备 audio 能力的 LLM」同池仲裁（`plugin-media/src/service.ts`）：

```ts
private asrProcessors(): MediaProcessor[] {
  return this.caps.asr.all().map(e => {
    const asr = e.instance;
    const name = `asr:${e.contextId}`;
    return {
      name, capabilities: ['audio'], priority: e.priority,
      transcribe: async input => {
        const r = await asr.transcribe(input);
        return { text: r.text, segments: r.segments, language: r.language,
                 meta: { processor: name, model: r.meta?.model } };
      },
    };
  });
}
```

它用 `asr.all()` 拿**全部** provider（不是单一胜者），让用户在 media 的 `audio.prefer` 里按 processor 名挑后端，再回退到按 priority 取最高（`service.ts`）。当 `name === 'asr'` 的 provider 注册/注销时，media 监听服务事件刷新候选（`plugin-media/src/index.ts`）。

---

## 3. 写一个 provider

### 最小骨架（可编译）

最小必须实现：一个返回 `{ text }` 的 `transcribe`，加 `provides`/`apply`。`segments`/`language`/`meta` 全可选。

```ts
import { asr } from '@aalis/api-asr';
import type { ASRService, TranscribeInput, TranscribeResult } from '@aalis/api-asr';
import { processService } from '@aalis/api-process';
import { storage } from '@aalis/api-storage';
import { config, definePlugin, logger, optional, provide } from '@aalis/core';

export default definePlugin({
  name: '@aalis/plugin-asr-mybackend',
  reusable: true,
  provides: [asr],
  uses: {
    provide,
    logger,
    config,
    process: optional(processService),
    storage: optional(storage),
  },
  apply({ provide, logger, config, process, storage }) {
    const priority = (config.priority as number | undefined) ?? 50;
    const impl: ASRService = {
      async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
        void process.current;
        void storage.current;
        // input.attachment.data 形态见 §4「物化附件」；远程下载必须走 safeFetch
        return { text: String(input.language ?? '') };
      },
    };
    provide(asr, impl, { priority });
    logger.info('asr provider ready');
  },
});
```

### 注册要点

- `provide(descriptor, instance, { priority, label, entryId })`（签名 `packages/core/src/composition/core-services.ts`）。同名多 provider 共存，胜者按「偏好 > 优先级 > 注册顺序」（`docs/concepts/service-model.md`、`docs/core/service.md`）。
- **priority**：普通数字，越大越优先，含义自行记载。参考实现用 50（云）/ 80（本地，质量更高默认更优先），并把 priority 暴露为可配置项让用户重排。
- **缺必填配置要抛错，不要静默 `return`**：因为声明了 `provides:['asr']` 却没 `provide`，core 激活后校验会把插件标记为 error（`docs/concepts/manifest-metadata.md` §`provides` / `plugin-activation.ts`），错误信息很难懂。参考实现的做法是抛清晰中文错误（`plugin-asr-openai/src/index.ts`、`plugin-asr-whisper-cpp/src/index.ts`）。
- 若你想被 media 的 `audio.prefer` 精确选中，注意 media 生成的 processor 名是 `asr:${contextId}`，可在 `provide` 时传 `label` 让 WebUI 列表更可读（media 在 `displayName` 里用了它，`service.ts`）。

### 双源元数据要对齐

manifest 是双源的（`docs/concepts/manifest-metadata.md`）：
- **源 A（运行时 DI，core 读）**：模块导出 `provides` / `uses`。
- **源 B（安装前披露，市场读）**：`package.json` 的 `aalis.service.{provides,required,optional}`。core 不读源 B，市场不读源 A，两者无对账。

两源必须写全同一份信息，否则各自失真。典型陷阱是源 A 声明了 `provides`、源 B 却只写 `required`/`optional`（`optional`/`required`）漏了 `provides`：运行时完全正常（core 只看源 A），但 npm 市场的「装它会引入哪些服务」披露里**不会显示该插件提供 `asr`**。两个参考实现的 `package.json` 都已把两源写全：

```jsonc
// plugin-asr-openai/package.json
"aalis": { "service": { "provides": ["asr"], "optional": ["process", "storage"] } }
// plugin-asr-whisper-cpp/package.json
"aalis": { "service": { "provides": ["asr"], "required": ["process", "storage"] } }
```

---

## 4. 标准消费方式

### lazy 取服务，不要缓存实例

```ts
import type { MessageAttachment } from '@aalis/schema-message';
import { asr } from '@aalis/api-asr';
import { definePlugin, optional } from '@aalis/core';

export default definePlugin({
  name: '@acme/plugin-example-asr-consumer',
  uses: { asr: optional(asr) },
  apply({ asr }) {
    async function transcribeOne(att: MessageAttachment) {
      const svc = asr.current;
      if (!svc) return undefined;
      const { text } = await svc.transcribe({ attachment: att, language: 'zh' });
      return text;
    }
    void transcribeOne;
  },
});
```

`.current` 返回的是**当时点的裸实例**，provider 发生换跳（热插拔 / 偏好切换）不会跟随（`packages/core/src/composition/descriptors.ts`）。所以每次用都重新读取 `.current`，不要缓存到类字段。详见 `docs/concepts/lazy-service-access.md`。

### asr 是可选依赖，缺失要降级

`asr` 几乎总该声明为 `uses optional`（像 media 那样），因为单 owner 工程可能未安装任何语音后端。消费方拿到 `undefined` 时应静默返回「未识别」占位，而不是抛错——media 的做法是日志 debug 后 `return undefined`（`plugin-media/src/service.ts`），并在最终描述里补占位文本让主 LLM 知情「有音频但没识别」（`service.ts`）。

### 错误边界

`transcribe` 失败会抛（参考实现里 API 非 2xx、ffmpeg/whisper-cli 失败都 throw）。消费方应 try/catch 并降级，不要让单条音频识别失败中断整条消息管线（media `service.ts`）。

---

## 5. 物化附件 + 能力/风险

`input.attachment.data` 是字符串，provider 必须自己解析来源。两个参考实现的解析顺序一致（`plugin-asr-openai/src/index.ts`、`plugin-asr-whisper-cpp/src/index.ts`），可直接沿用：

1. **base64 data URL**：`/^data:([^;]+);base64,(.+)$/`，解码即得字节。**注意必须带 `;base64,`**——否则会和 storage URI `data:/...`（根名恰好叫 `data`）混淆。
2. **`file://` 或裸绝对路径 `/...`**：openai 走 `proc.readExternalFile(data)`（治外文件能力，避免直接 `import node:fs`，`plugin-asr-openai/src/index.ts`）；whisper-cpp 直接取 `file://` 后的本地路径喂 ffmpeg。
3. **`http(s)://`**：**必须用 `safeFetch`（`@aalis/util-network-guard`）下载**，不要用裸 `fetch`（见 §6）。`safeFetch` 只管 SSRF 与重定向，不带超时也不限体积，下载方要自己补上：两个参考实现与 plugin-media 同口径，超时 15 秒（覆盖连接与读完响应体）、体积上限 20 MiB（按流式累计判定，超限即断并抛错），不要整读 `arrayBuffer()`。
4. **storage URI / 历史裸相对路径**：`isStorageUri(data)` 判定（`packages/api-storage/src/index.ts`）；历史格式 `data/...` 补成 `data:/...`。openai 用 `storage.readFile(uri)` 读字节；whisper-cpp 用 `storage.resolveLocalPath?.(uri, 'read')` 拿本地路径喂 ffmpeg。

process/storage 经 gateway 注入：`createProcessGateway(process)` / `createStorageGateway(storage)`（`api-process/src/index.ts`、`api-storage/src/index.ts`），临时文件用 `proc.makeTempDir(prefix)`（返回 `{ path, uri, cleanup }`，`api-process/src/index.ts`），用完务必 `cleanup()`（whisper-cpp 在 `finally` 里清理，`plugin-asr-whisper-cpp/src/index.ts`）。

### SSRF / 网络出口

任何下载远端音频的路径**必须经 `safeFetch`**——它是 SSRF 受控出口（拦内网地址、限重定向，`packages/util-network-guard/src/index.ts`），见 `docs/concepts/security-model.md`。`attachment.data` 来自外部消息（用户、群、平台），可能携带攻击者控制的 URL。

> 注意：asr-openai 用 `safeFetch` 仅下载 http(s) **附件**（`plugin-asr-openai/src/index.ts`），但向 `cfg.baseUrl/audio/transcriptions` 发起的转写 POST 用的是**裸 `fetch`**。这是配置型出口（`baseUrl` 由 owner 配，非外部输入），风险面与「外部 URL 下载」不同；但若你的后端 baseUrl 可能来自不可信源，应同样收口到 safeFetch。

### storage 不是沙箱

`resolveLocalPath` 把绝对路径交给 ffmpeg / whisper-cli 等子进程后，storage URI 的访问控制就**不再约束**这些子进程（`packages/api-storage/src/index.ts`）。provider 应只把自己物化出来的临时文件路径交给子进程，别把用户可控路径直接拼进命令行。storage URI 文法见 `docs/concepts/storage-uri-grammar.md`、`docs/services/storage.md`。

### 风险等级 / 鉴权

`asr` 接口本身不接触 authority——它是被 media/agent 间接调用的纯转换服务，鉴权发生在更上游（谁能触发媒体处理 / 工具）。provider 无需自行做等级校验；若你的后端要暴露成可被 LLM 直接调用的工具，那条工具才按 `risk → minLevel` 标注（见 `docs/plugins/plugin-authority.md`、`docs/services/tools.md`）。

---

## 6. 注意事项与边界情形

- **asr-openai 转写 POST 用裸 fetch**：仅附件下载走 safeFetch（详见 §5）。
- **whisper-cpp 是重外部依赖**：需 `brew install whisper-cpp` + ffmpeg + 下载 GGML 模型（`plugin-asr-whisper-cpp/src/index.ts`），缺 `modelPath` 直接抛错。
- **whisper-cpp 时间戳被丢**：它命令行带 `-nt`（no timestamps）只取纯文本（`plugin-asr-whisper-cpp/src/index.ts`），`TranscribeInput.withTimestamps` 在该后端**无效**，`TranscribeResult.segments` 永远为空。需要分段的消费方应优先选 openai 后端（`verbose_json`，`plugin-asr-openai/src/index.ts`）。
- **空文本 ≠ 非语音**：whisper-cpp 静音返回空串；media 把空 `text` 当「识别失败」补占位（`plugin-media/src/service.ts`），消费方不应把空串解释成「确定无内容」。

---

## 7. 交叉链接

- `docs/concepts/service-model.md` —— DI 按名仲裁（偏好 > 优先级 > 注册顺序）、无 capability 选择
- `docs/concepts/lazy-service-access.md` —— 为什么每次读取 `.current`、provider bounce
- `docs/concepts/manifest-metadata.md` —— `provides`/`uses` 双源、市场披露
- `docs/concepts/storage-uri-grammar.md` —— `<root>:/path` 文法、`isStorageUri`
- `docs/concepts/security-model.md` —— `safeFetch` SSRF 防护、storage 非沙箱
- `docs/concepts/message-llm-pipeline.md` —— asr 在多模态/消息管线中的位置
- `docs/services/process.md` / `docs/services/storage.md` —— provider 物化附件依赖的两个服务
- `docs/services/llm.md` —— LLM-as-audio 后端（与 asr 同走 media 的 audio cap 池）
