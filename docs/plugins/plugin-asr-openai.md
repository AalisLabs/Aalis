# plugin-asr-openai — OpenAI Whisper API 转写后端

**包名**: `@aalis/plugin-asr-openai`  
**源码**: `packages/plugin-asr-openai/src/index.ts`

## 概述

语音识别（ASR）的 OpenAI Whisper API 提供者。插件向核心注册 `asr` 服务，实现只有一个 `transcribe` 方法：把音频附件封装为 multipart 表单，POST 到 `baseUrl` 下的 `/audio/transcriptions`，返回文本与可选的时间戳分段。凡实现 OpenAI 风格 `/audio/transcriptions` 协议的服务端（如 Groq、本地 ollama-asr 网关）均可经 `baseUrl` 接入。音频附件支持以下来源：base64 data URL、`file://` 或绝对路径（经 process 服务读取）、http(s) URL（经 `safeFetch` 下载）、storage URI（经 storage 服务读取；历史遗留的裸相对路径 `data/...` 按 `data:/...` 处理）。其它格式直接抛错。

上传的文件名后缀按 Whisper API 实际接受的集合（`flac` / `m4a` / `mp3` / `mp4` / `mpeg` / `mpga` / `oga` / `ogg` / `wav` / `webm`）判定：来源路径的后缀在集内就沿用，否则（无后缀、或 `opus`、`amr` 这类 API 判 400 的后缀）按 Content-Type 映射到集内后缀，都取不到落 `wav`。后缀只决定上传文件名，插件不做转码。

## 插件声明

```typescript
meta.name = '@aalis/plugin-asr-openai'
meta.displayName = 'OpenAI Whisper ASR'
meta.subsystem = 'media'
meta.provides = ['asr']
meta.inject = { optional: ['process', 'storage'] }
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `apiKey` | string | `''` | API Key（secret） |
| `baseUrl` | string | `'https://api.openai.com/v1'` | Base URL |
| `model` | string | `'whisper-1'` | 模型 |
| `priority` | number | `50` | 优先级 (越大越优先) |

`apiKey` 为必填：未配置时 `apply` 直接抛错，不注册服务；不使用本插件时应在插件管理中禁用。请求地址为 `baseUrl`（去除末尾斜杠）直接拼接 `/audio/transcriptions`，插件不会自动补版本前缀，因此 `baseUrl` 应写到版本前缀为止（例如 OpenAI 官方为 `https://api.openai.com/v1`）。`priority` 作为 `ctx.provide` 的优先级传入。media 选择音频后端时，`audio.prefer` 指定的处理器存在则直接采用，否则在统一音频池（含具备音频能力的 LLM）中取优先级最高者。

## 相关

- 服务契约 `@aalis/api-asr`：[services/asr.md](../services/asr.md)
- 消费方 `media` 服务：[services/media.md](../services/media.md)
