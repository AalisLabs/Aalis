# plugin-image-recognition — 图像视觉识别

**包名**: `@aalis/plugin-image-recognition`  
**源码**: `packages/plugin-image-recognition/src/index.ts`

## 概述

多模态视觉预处理插件，将消息中的图片通过视觉 LLM 转换为文字描述后注入上下文。支持自动模型选择或指定偏好模型。
识别时会把当前消息、引用消息和最近前文作为线索传入视觉模型；当 Agent 未触发、消息归档插件兜底处理图片时，也会通过 `image-recognition.buildContext()` 复用同一套上下文构造逻辑。

## 插件声明

```typescript
meta.name = '@aalis/plugin-image-recognition'
meta.inject = { required: [{ service: 'llm', capabilities: ['vision'] }] }
```

## 工作方式

1. 通过 `agent:input:before` 钩子拦截包含图片的消息
2. 调用具有 `vision` 能力的 LLM 服务
3. 以 ~300 token 的预算生成图片描述
4. 将描述文本追加到消息内容中
5. 自动选择最佳视觉模型，或使用用户偏好设置

## 上下文

- 当前消息最多保留 500 字
- 引用消息最多保留 500 字
- 最近前文默认取最近 4 条 `user`/`assistant` 消息，每条最多 220 字
- 传给视觉模型前，整体上下文最多保留 1200 字
- 上下文只作为识别重点的线索，不应覆盖图片本身可见事实
