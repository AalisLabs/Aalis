# @aalis/api-media

多模态媒体识别契约：图像 / 音频 / 视频处理为文本。

## 安装

```bash
pnpm add @aalis/api-media
```

## 提供

服务描述符：`media`（服务名 `media`）。

```ts
import { media } from '@aalis/api-media';
```

实现见 `@aalis/plugin-media`。

另导出两组纯函数（不依赖 `media` 服务在场）：

- 会话媒体的目录约定：`MEDIA_KIND_DIRS`、`sessionDirName`、`sessionMediaUri`、`clearSessionMedia`。写入方把会话里收发与产生的媒体写进 `data:/<种类目录>/<会话目录>/<写入方>/`，并挂 `memory:clear` 中间件清自己的子目录。
- 媒体按受众的判据：`mediaInScope`、`mediaRef`、`historyMediaRefs`。

## 文档

详见 [docs/services/media.md](../../docs/services/media.md)。

## 许可

见仓库根目录 LICENSE。
