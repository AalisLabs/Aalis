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
| `timeoutMs` | number | `600000` | 子进程超时 (ms)：转码与识别子进程的最长运行时间。设 0 表示不限——届时卡住的子进程会把整轮对话一起挂住 |

`modelPath` 为必填：未配置时 `apply` 直接抛错，插件不会注册 `asr` 服务。`priority` 作为 `ctx.provide('asr', ...)` 的注册优先级。

## 相关

- `asr` 服务契约与参考实现对照：[services/asr.md](../services/asr.md)
- 消费方 media 服务（把 asr provider 纳入 audio 池）：[services/media.md](../services/media.md)
- 依赖的 `process` / `storage` 服务：[services/process.md](../services/process.md)、[services/storage.md](../services/storage.md)

## 子进程超时

ffmpeg 转码与 whisper-cli 识别都经 `ProcessService.execFile` 带 `timeout` 调用：转码分到 `timeoutMs / 2`，识别拿完整 `timeoutMs`，两段都卡住时整体上界是 `1.5 × timeoutMs`。

默认值取 10 分钟而非更紧的数值：这道闸的目的是掐断**真正卡死**的子进程，不是给识别限速。CPU 上跑长语音本来就可能要几分钟，闸设得太紧会把本来能用的识别切掉——那是把一个挂死问题换成一个功能问题。

这个参数不是调优项而是必需项——`plugin-process-local` 的 `spawn` 只在 `opts.timeout > 0` 时才武装 `killTree`，不传就意味着子进程不退时 `wait()` 永不 settle：那一轮对话被永久挂住（回合 abort 也停不掉已经起来的子进程），而每条音频都会再堆一个 whisper/ffmpeg 进程。
