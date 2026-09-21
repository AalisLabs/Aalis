# @aalis/api-asr

语音识别（ASR）服务契约：把音频转成文本。

## 安装

```bash
pnpm add @aalis/api-asr
```

## 提供

服务描述符：`asr`（服务名 `asr`）。

```ts
import { asr } from '@aalis/api-asr';
```

实现见 `@aalis/plugin-asr-openai`、`@aalis/plugin-asr-whisper-cpp`。

## 文档

详见 [docs/services/asr.md](../../docs/services/asr.md)。

## 许可

见仓库根目录 LICENSE。
