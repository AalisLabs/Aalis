# plugin-office — Office 文档操作

**包名**: `@aalis/plugin-office`  
**源码**: `packages/plugin-office/src/index.ts`

## 概述

Word (docx)、Excel (xlsx)、PowerPoint (pptx) 和 PDF 文档的创建与编辑工具集。支持共享 docId 机制，允许子任务协同操作同一文档。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-office',
  displayName: 'Office 文档工具',
  subsystem: 'tools',
  uses: {
    tools,
    storage,
    processService: optional(processService),
    logger,
    lifecycle,
    config,
  },
  apply(caps) { /* 见源码 */ },
});
```

## 配置

以下各项来自 `packages/plugin-office/src/index.ts` 的 `configSchema`；某类文档的 `enabled` 为 false 时，该类工具不注册。

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `outputDir` | string | `'workspace:/'` | 输出目录：文档保存目录（storage URI，如 workspace:/ 或 data:/docs），也兼容裸名「workspace」/「data」。 |
| `docx` | object | — | Word 文档 |
| `docx.enabled` | boolean | `true` | 启用 Word 工具 |
| `xlsx` | object | — | Excel 工作簿 |
| `xlsx.enabled` | boolean | `true` | 启用 Excel 工具 |
| `pptx` | object | — | PPT 演示文稿 |
| `pptx.enabled` | boolean | `true` | 启用 PPT 工具 |
| `pdf` | object | — | PDF 文档 |
| `pdf.enabled` | boolean | `true` | 启用 PDF 工具 |

## 注册工具

四类全部启用时共注册 38 个工具（Word 11、Excel 10、PowerPoint 12、PDF 5），均归入 `office` 工具组。

### Word (docx)

创建文档，添加标题、段落、列表、表格、图片、分页符、目录，设置页眉页脚与全局默认样式，保存到输出目录。转 PDF 使用 PDF 类的 `pdf_convert`。

### Excel (xlsx)

创建工作簿，添加工作表，批量写入单元格，合并单元格，设置公式、样式、数据验证、条件格式，保存到输出目录。`excel_add_chart` 不会实际嵌入图表（ExcelJS 不支持），只返回失败提示，并建议改用 `ppt_add_chart`。

### PowerPoint (pptx)

创建演示文稿（比例可选 16:9、4:3、宽屏；可选 clean、dark、corporate、minimal、nature、warm 六套预设模板，使用模板时自动注册 title、content、section、end 四个母版，`ppt_list_templates` 列出可用模板），添加幻灯片、文本框、图片、形状、图表、表格（坐标以英寸为单位，自动钳制到幻灯片范围内），定义自定义母版，保存到输出目录。`ppt_set_transition` 与 `ppt_set_animation` 不会实际设置切换效果或动画，只返回失败提示。

### PDF

两条路径：

- `pdf_create`、`pdf_add_text`、`pdf_add_page`、`pdf_save` 用 pdf-lib 直接生成简单文本 PDF，标准字体只支持 ASCII/Latin 字符。
- `pdf_convert` 调用 LibreOffice（`soffice --headless --convert-to pdf`）把已保存的 docx/pptx/xlsx 文件转成 PDF，需要可选依赖 `process` 服务、存储支持本地路径解析（`resolveLocalPath`），并且系统装有 LibreOffice；前提不满足时返回失败提示。

## 共享 docId

每个文档通过 `docId` 标识。会话保存在插件内存中：最多 50 个，超出时逐出最久未操作的；超过 30 分钟未操作即失效；调用对应的 `*_save` 后释放；插件卸载或重载时清空。父任务创建文档得到 `docId` 后，可以把它交给子任务继续编辑同一文档；所有子任务完成后再调用保存工具。
