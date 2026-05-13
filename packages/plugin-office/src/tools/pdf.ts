import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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

export function registerPdfTools(tools: ScopedToolService, sessions: DocSessionManager, outputDir: string) {
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
      const filePath = resolve(outputDir, session.filename);
      mkdirSync(dirname(filePath), { recursive: true });
      const pdfBytes = await state.pdfDoc.save();
      writeFileSync(filePath, pdfBytes);
      sessions.remove(session.id);
      return JSON.stringify({
        success: true,
        path: filePath,
        pages: state.pdfDoc.getPageCount(),
        size: pdfBytes.length,
        message: `PDF 已保存: ${filePath}`,
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
      const inputPath = resolve(outputDir, String(args.inputPath));
      const outDir = args.outputDir ? resolve(outputDir, String(args.outputDir)) : dirname(inputPath);
      mkdirSync(outDir, { recursive: true });

      try {
        execFileSync('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', outDir, inputPath], {
          timeout: 60000,
        });

        const baseName = inputPath
          .replace(/\.[^.]+$/, '.pdf')
          .split('/')
          .pop();
        const pdfPath = resolve(outDir, baseName || 'output.pdf');

        return JSON.stringify({ success: true, path: pdfPath, message: `已转换为 PDF: ${pdfPath}` });
      } catch (e: any) {
        return JSON.stringify({
          success: false,
          message: `PDF 转换失败。请确保已安装 LibreOffice 且 soffice 命令可用。错误: ${e.message}`,
        });
      }
    },
  });
}
