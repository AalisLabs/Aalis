# plugin-image-recognition — 图像视觉识别

**包名**: `@aalis/plugin-image-recognition`  
**源码**: `packages/plugin-image-recognition/src/index.ts`

## 概述

多模态视觉预处理插件，将消息中的图片通过视觉 LLM 转换为文字描述后注入上下文。支持自动模型选择或指定偏好模型。

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
