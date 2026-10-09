# plugin-asr-whisper-cpp — 本地 whisper.cpp 语音识别

**包名**: `@aalis/plugin-asr-whisper-cpp`  
**源码**: `packages/plugin-asr-whisper-cpp/src/index.ts`

## 概述

语音识别（ASR）的本地 whisper.cpp 提供者：调用 whisper.cpp 提供的 `whisper-cli` 二进制完成转写，以 `asr` 服务注册。使用前需安装 whisper.cpp（如 `brew install whisper-cpp`）并下载模型文件（如 `ggml-base.bin`）。输入音频先经 ffmpeg 转为 16kHz 单声道 WAV，再交给 `whisper-cli`。

## 插件声明

```ts
definePlugin({
  name: '@aalis/plugin-asr-whisper-cpp',
  displayName: 'Whisper.cpp 本地转写',
  subsystem: 'media',
  provides: [asr],
  uses: {
    logger,
    config,
    provide,
    proc: processService,
    storage,
  },
  apply(caps) { /* 见源码 */ },
})
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `binaryPath` | string | `'whisper-cli'` | whisper-cli 路径：绝对路径，或 PATH 里能找到的命令名；留空时用默认值 |
| `modelPath` | string | 必填 | 模型文件路径 (.bin)：GGML 模型文件（.bin）的绝对路径 |
| `language` | string | `'auto'` | 默认语种 |
| `threads` | number | `4` | 线程数 |
| `timeoutMs` | number | `600000` | 子进程超时 (ms)：转码与识别子进程的最长运行时间。设 0 表示不限——届时卡住的子进程会把整轮对话一起挂住 |

`modelPath` 为必填：没填时插件激活失败，报「缺少配置项 modelPath」，WebUI 把它标成待配置，不注册 `asr` 服务。`binaryPath` 声明为必填并带默认值，留空时回到默认的 `whisper-cli`，不会以空命令运行。两个路径字段都不收相对路径（宿主进程的 cwd 不带语义），写了相对路径时插件拒绝激活。登记 `asr` 服务时的优先级是插件里的常量 80（云端接口 plugin-asr-openai 为 50），只作第一方提供者之间的默认先后，不可配置。转写由 media 调用，用哪个音频后端由 media 的 `audio.prefer` 定（处理器名为 `asr:<插件实例 id>`），没指定时取统一音频池里优先级最高的；服务偏好 `servicePreferences.asr` 在那里只在优先级相同时决胜。

## 相关

- `asr` 服务契约与参考实现对照：[services/asr.md](../services/asr.md)
- 消费方 media 服务（把 asr provider 纳入 audio 池）：[services/media.md](../services/media.md)
- 依赖的 `process` / `storage` 服务：[services/process.md](../services/process.md)、[services/storage.md](../services/storage.md)

## 子进程超时

ffmpeg 转码与 whisper-cli 识别都经 `ProcessService.execFile` 带 `timeout` 调用：转码分到 `timeoutMs / 2`，识别拿完整 `timeoutMs`，两段子进程都卡住时上界是 `1.5 × timeoutMs`。http(s) 音频附件的下载不受 `timeoutMs` 约束，另有固定的 15 秒超时与 20 MiB 体积上限（与 plugin-media 同口径），超时或超限直接抛错。

默认值取 10 分钟而非更紧的数值：这道闸的目的是掐断**真正卡死**的子进程，不是给识别限速。CPU 上跑长语音本来就可能要几分钟，闸设得太紧会把本来能用的识别切掉——那是把一个挂死问题换成一个功能问题。

这个参数不是调优项而是必需项——`plugin-process-local` 的 `spawn` 只在 `opts.timeout > 0` 时才武装 `killTree`，不传就意味着子进程不退时 `wait()` 永不 settle：那一轮对话被永久挂住（回合 abort 也停不掉已经起来的子进程），而每条音频都会再堆一个 whisper/ffmpeg 进程。

## 配置校验

可执行文件、模型路径、语言、线程数与进程超时的显式无效值会在注册服务前报配置错误。未填模型路径仍报缺失；`timeoutMs` 为 0 或负数时仍按不限时处理。
