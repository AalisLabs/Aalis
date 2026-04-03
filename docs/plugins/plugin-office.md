# plugin-office — Office 文档操作

**包名**: `@aalis/plugin-office`  
**源码**: `packages/plugin-office/src/index.ts`

## 概述

Word (docx)、Excel (xlsx)、PowerPoint (pptx) 和 PDF 文档的创建与编辑工具集。支持共享 docId 机制，允许子任务协同操作同一文档。

## 插件声明

```typescript
meta.name = '@aalis/plugin-office'
meta.inject = {}
```

## 注册工具（37 个）

### Word (docx)

创建文档、添加段落/标题/列表/表格/图片、设置样式、导出 PDF。

### Excel (xlsx)

创建工作簿、添加/读取工作表、写入单元格/范围、设置样式/公式、添加图表。

### PowerPoint (pptx)

创建演示文稿、添加幻灯片、添加文本框/图片/形状/表格、幻灯片布局、模板系统、定位控制。

### PDF

基于已有文档生成 PDF 导出。

## 共享 docId

每个文档通过 `docId` 标识。当使用子任务系统时，父任务创建文档获得 `docId`，子任务可通过该 `docId` 继续编辑同一文档，实现多任务协同。
