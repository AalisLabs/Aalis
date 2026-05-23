import type { ProcessService } from '@aalis/plugin-process-api';
import type { StorageService } from '@aalis/plugin-storage-api';
import type { ScopedToolService } from '@aalis/plugin-tools-api';
import { PageSizes, PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import type { DocSessionManager } from '../session.js';

// pdf-lib 仅支持 ASCII 标准字体，中文等需要嵌入字体。
// 这里提供基础 PDF 生成，复杂排版建议先生成 docx/pptx/xlsx 后通过 pdf_convert 转换。

interface PdfState {
  pdfDoc: PDFDocument;
  fontSize: number;
  fontName: string;
  margin: number;
  cursorY: number;
  pageWidth: number;
  pageHeight: number;
}

export function registerPdfTools(
  tools: ScopedToolService,
  sessions: DocSessionManager,
  storage: StorageService,
  outputUri: string,
  proc?: ProcessService,
) {
  function joinUri(base: string, rel: string): string {
    const b = base.endsWith('/') ? base : `${base}/`;
    return `${b}${rel.replace(/^\/+/, '')}`;
  }
  function parentUri(uri: string): string {
    const i = uri.lastIndexOf('/');
    return i > 0 ? uri.slice(0, i) : uri;
  }
  function baseName(uri: string): string {
    const i = uri.lastIndexOf('/');
    return i >= 0 ? uri.slice(i + 1) : uri;
  }
  function toUri(input: string): string {
    if (input.includes(':/')) return input;
    return joinUri(outputUri, input);
  }
  // 辅助：获取或新建页面
  function ensurePage(state: PdfState): ReturnType<PDFDocument['addPage']> {
    const pages = state.pdfDoc.getPages();
    if (pages.length === 0 || state.cursorY < state.margin) {
      const page = state.pdfDoc.addPage([state.pageWidth, state.pageHeight]);
      state.cursorY = state.pageHeight - state.margin;
      return page;
    }
    return pages[pages.length - 1];
  }

  // ---- pdf_create ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'pdf_create',
        description: '创建新的 PDF 文档会话。适合简单文本报告。复杂排版建议先创建 Word/PPT 文档再用 pdf_convert 转换。',
        parameters: {
          type: 'object',
          properties: {
            filename: { type: 'string', description: '文件名（如 report.pdf）' },
            title: { type: 'string', description: '文档标题（元数据）' },
            author: { type: 'string', description: '作者' },
            pageSize: { type: 'string', enum: ['A4', 'Letter', 'Legal'], description: '页面大小，默认 A4' },
            margin: { type: 'number', description: '页边距（点），默认 50' },
          },
          required: ['filename'],
        },
      },
    },
    async handler(args) {
      const pdfDoc = await PDFDocument.create();
      if (args.title) pdfDoc.setTitle(String(args.title));
      if (args.author) pdfDoc.setAuthor(String(args.author));
      pdfDoc.setCreationDate(new Date());

      const sizes: Record<string, [number, number]> = {
        A4: PageSizes.A4,
        Letter: PageSizes.Letter,
        Legal: PageSizes.Legal,
      };
      const [w, h] = sizes[String(args.pageSize || 'A4')] || PageSizes.A4;
      const margin = args.margin != null ? Number(args.margin) : 50;

      const state: PdfState = {
        pdfDoc,
        fontSize: 12,
        fontName: 'Helvetica',
        margin,
        cursorY: h - margin,
        pageWidth: w,
        pageHeight: h,
      };

      // 添加第一页
      pdfDoc.addPage([w, h]);

      const docId = sessions.create('pdf', String(args.filename || 'document.pdf'), state);
      return JSON.stringify({ docId, filename: args.filename, message: 'PDF 文档已创建' });
    },
  });

  // ---- pdf_add_text ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'pdf_add_text',
        description: '向 PDF 添加文本。注意：标准字体仅支持 ASCII/Latin 字符，中文请使用 pdf_convert 方案。',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: '文档会话 ID' },
            text: { type: 'string', description: '文本内容' },
            fontSize: { type: 'number', description: '字号（磅），默认 12' },
            bold: { type: 'boolean', description: '加粗' },
            x: { type: 'number', description: '自定义 X 坐标（覆盖默认边距）' },
            color: { type: 'string', description: '颜色：hex如 "#FF0000" 或名称 "red"' },
          },
          required: ['docId', 'text'],
        },
      },
    },
    async handler(args) {
      const session = sessions.require(String(args.docId));
      const state = session.doc as PdfState;
      const page = ensurePage(state);

      const fontSize = args.fontSize ? Number(args.fontSize) : state.fontSize;
      const fontKey = args.bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica;
      const font = await state.pdfDoc.embedFont(fontKey);

      let color = rgb(0, 0, 0);
      if (args.color) {
        const hex = String(args.color).replace('#', '');
        if (hex.length === 6) {
          color = rgb(
            parseInt(hex.slice(0, 2), 16) / 255,
            parseInt(hex.slice(2, 4), 16) / 255,
            parseInt(hex.slice(4, 6), 16) / 255,
          );
        }
      }

      const text = String(args.text);
      const lines = text.split('\n');
      const x = args.x != null ? Number(args.x) : state.margin;

      for (const line of lines) {
        if (state.cursorY < state.margin) {
          state.pdfDoc.addPage([state.pageWidth, state.pageHeight]);
          state.cursorY = state.pageHeight - state.margin;
        }
        page.drawText(line, { x, y: state.cursorY, size: fontSize, font, color });
        state.cursorY -= fontSize * 1.4;
      }

      return JSON.stringify({ success: true, message: `已写入 ${lines.length} 行文本` });
    },
  });

  // ---- pdf_add_page ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'pdf_add_page',
        description: '向 PDF 添加新页面。',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: '文档会话 ID' },
          },
          required: ['docId'],
        },
      },
    },
    async handler(args) {
      const session = sessions.require(String(args.docId));
      const state = session.doc as PdfState;
      state.pdfDoc.addPage([state.pageWidth, state.pageHeight]);
      state.cursorY = state.pageHeight - state.margin;
      return JSON.stringify({ success: true, message: '新页面已添加' });
    },
  });

  // ---- pdf_save ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'pdf_save',
        description: '保存 PDF 文档到文件并释放会话。',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: '文档会话 ID' },
          },
          required: ['docId'],
        },
      },
    },
    async handler(args) {
      const session = sessions.require(String(args.docId));
      const state = session.doc as PdfState;
      const fileUri = joinUri(outputUri, session.filename);
      const pdfBytes = await state.pdfDoc.save();
      await storage.writeFile(fileUri, Buffer.from(pdfBytes));
      sessions.remove(session.id);
      return JSON.stringify({
        success: true,
        path: fileUri,
        pages: state.pdfDoc.getPageCount(),
        size: pdfBytes.length,
        message: `PDF 已保存: ${fileUri}`,
      });
    },
  });

  // ---- pdf_convert ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'pdf_convert',
        description: '将 Office 文档（docx/pptx/xlsx）转换为 PDF。需要系统安装 LibreOffice（soffice 命令）。',
        parameters: {
          type: 'object',
          properties: {
            inputPath: { type: 'string', description: '输入文件路径（可以是 workspace 下的相对路径或绝对路径）' },
            outputDir: { type: 'string', description: '输出目录，默认与输入文件同目录' },
          },
          required: ['inputPath'],
        },
      },
    },
    async handler(args) {
      const inputUri = toUri(String(args.inputPath));
      const outUri = args.outputDir ? toUri(String(args.outputDir)) : parentUri(inputUri);
      const resolveLocal = storage.resolveLocalPath?.bind(storage);
      if (!resolveLocal) {
        return JSON.stringify({ success: false, message: 'PDF 转换需要存储提供本地路径能力（resolveLocalPath）。' });
      }
      let inputLocal: string;
      let outDirLocal: string;
      try {
        inputLocal = await resolveLocal(inputUri, 'read');
        outDirLocal = await resolveLocal(outUri, 'write');
      } catch (e) {
        return JSON.stringify({ success: false, message: `无法解析本地路径: ${(e as Error).message}` });
      }

      try {
        if (!proc) {
          return JSON.stringify({
            success: false,
            message: 'PDF 转换需要 process 服务，请启用 @aalis/plugin-process-local。',
          });
        }
        await proc.execFile('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', outDirLocal, inputLocal], {
          timeout: 60000,
        });

        const pdfName = baseName(inputUri).replace(/\.[^.]+$/, '.pdf') || 'output.pdf';
        const pdfUri = joinUri(outUri, pdfName);

        return JSON.stringify({ success: true, path: pdfUri, message: `已转换为 PDF: ${pdfUri}` });
        // biome-ignore lint/suspicious/noExplicitAny: catch 兜底，e 可能为任意类型
      } catch (e: any) {
        return JSON.stringify({
          success: false,
          message: `PDF 转换失败。请确保已安装 LibreOffice 且 soffice 命令可用。错误: ${e.message}`,
        });
      }
    },
  });
}
