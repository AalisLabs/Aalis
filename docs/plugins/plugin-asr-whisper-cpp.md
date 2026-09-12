# plugin-asr-whisper-cpp — 本地 whisper.cpp 语音识别

**包名**: `@aalis/plugin-asr-whisper-cpp`  
**源码**: `packages/plugin-asr-whisper-cpp/src/index.ts`

## 概述

语音识别（ASR）的本地 whisper.cpp 提供者：调用 whisper.cpp 提供的 `whisper-cli` 二进制完成转写，以 `asr` 服务注册。使用前需安装 whisper.cpp（如 `brew install whisper-cpp`）并下载模型文件（如 `ggml-base.bin`）。输入音频先经 ffmpeg 转为 16kHz 单声道 WAV，再交给 `whisper-cli`。

## 插件声明

```typescript
meta.name = '@aalis/plugin-asr-whisper-cpp'
meta.displayName = 'Whisper.cpp 本地转写'
meta.subsystem = 'media'
meta.provides = ['asr']
meta.inject = { required: ['process', 'storage'] }
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `binaryPath` | string | `'whisper-cli'` | whisper-cli 路径 |
| `modelPath` | string | `''` | 模型文件路径 (.bin) |
| `language` | string | `'auto'` | 默认语种 |
| `threads` | number | `4` | 线程数 |
| `priority` | number | `80` | 优先级 (越大越优先) |

`modelPath` 为必填：未配置时 `apply` 直接抛错，插件不会注册 `asr` 服务。`priority` 作为 `ctx.provide('asr', ...)` 的注册优先级。

## 相关

- `asr` 服务契约与参考实现对照：[services/asr.md](../services/asr.md)
- 消费方 media 服务（把 asr provider 纳入 audio 池）：[services/media.md](../services/media.md)
- 依赖的 `process` / `storage` 服务：[services/process.md](../services/process.md)、[services/storage.md](../services/storage.md)
