# plugin-image-recognition-api — 图片识别服务契约

**包名**: `@aalis/plugin-image-recognition-api`  
**源码**: `packages/plugin-image-recognition-api/src/index.ts`  
**实现**: `@aalis/plugin-image-recognition`

## 概述

把"图片 → 文字描述"的能力抽象成可替换服务。Agent / Memory / Archive 等消费方调用本服务而不直接耦合视觉模型，便于切换实现（多模态 LLM、专用视觉 API、本地推理）。

## 关键类型

```ts
interface ImageRecognitionInput {
  content: string;
  images: string[];
  context?: string;
  attachmentOrder?: Array<'image' | 'file'>;
}

interface ImageRecognitionResult {
  content: string;
  imageDescriptions?: string[];
  info: {
    imageCount: number;
    successCount: number;
    descriptions: string[];
    transformedContent: string;  // 已把 [图] 占位替换成 "[图: xxx]"
  };
}
```

## 服务接口

```ts
interface ImageRecognitionService {
  readonly available: boolean;       // 当前是否可用（LLM 就绪 + 配置开启）
  readonly enabled: boolean;         // true=替换为文字；false=透传原图

  describe(imageUrl: string, localRefPath?: string): Promise<string>;
  processMessage(input: ImageRecognitionInput): Promise<ImageRecognitionResult | null>;
  buildContext?(message: IncomingMessage, options?: { beforeLimit?: number }): Promise<string>;
  lookupDescription?(imageUrl: string): string | null;
}
```

## Capability 框架

通过 `declare module '@aalis/core' { interface ServiceCapabilityMap }` 注入，可声明的能力：

- `describe` —— 单图描述
- `process-message` —— 整条消息批处理
- `build-context` —— 构造识别上下文
- `animated` —— GIF / 视频帧综合描述

第三方实现可扩展 capability：

```ts
declare module '@aalis/plugin-image-recognition-api' {
  interface ImageRecognitionCapabilityRegistry {
    Ocr: 'ocr';
    ObjectDetection: 'object_detection';
  }
}
```

## 典型流程

`plugin-image-recognition` 注册一个 `agent:input:before` preprocessor，在消息到达 LLM 前调用 `processMessage()`，把 `images` 替换为文字写到 `_imageDescriptions` 与 `transformedContent`，下游 Agent 直接看到文字版。

引用回复场景下，`lookupDescription()` 可免去重复识别。

## 实现者

- [@aalis/plugin-image-recognition](../plugins/plugin-image-recognition.md)

## 相关

- `IncomingMessage._imageDescriptions / _imageRecognitionInfo` 字段定义在 [plugin-message-api](./plugin-message-api.md)
