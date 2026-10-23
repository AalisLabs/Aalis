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
- 媒体判据：`mediaScopeOf`、`mediaInScope`、`localFileInScope`、`mediaRef`、`historyMediaRefs`。本会话的媒体放行，别的会话的媒体交给调用方给的取用判定，不属于任何会话的本机文件交给本机文件判定。`mediaScopeOf` 按一次调用给出第一方的两样判定（会话管理的取用规则；`localFileInScope`，按这一轮的主体），按路径取存储媒体的工具用它。

## 文档

详见 [docs/services/media.md](../../docs/services/media.md)。

## 许可

见仓库根目录 LICENSE。
