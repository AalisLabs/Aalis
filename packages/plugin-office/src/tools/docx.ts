import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Context } from '@aalis/core';
import {
  AlignmentType,
  BorderStyle,
  convertInchesToTwip,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  PageBreak,
  Paragraph,
  Table,
  TableCell,
  TableOfContents,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import type { DocSessionManager } from '../session.js';
import { loadImage } from '../utils.js';

interface DocState {
  doc: Document | null;
  sections: SectionChildren[];
  styles: DocStyles;
}

interface DocStyles {
  defaultFontFamily?: string;
  defaultFontSize?: number;
  defaultColor?: string;
}

type SectionChildren = Paragraph | Table;

const headingMap: Record<string, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  '1': HeadingLevel.HEADING_1,
  '2': HeadingLevel.HEADING_2,
  '3': HeadingLevel.HEADING_3,
  '4': HeadingLevel.HEADING_4,
  '5': HeadingLevel.HEADING_5,
  '6': HeadingLevel.HEADING_6,
};

const alignMap: Record<string, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED,
};

export function registerDocxTools(ctx: Context, sessions: DocSessionManager, outputDir: string) {
  // ---- doc_create ----
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'doc_create',
        description:
          '创建一个新的 Word 文档会话，返回 docId 用于后续操作。该 docId 全局共享，可传递给子任务实现并行协作编辑。',
        parameters: {
          type: 'object',
          properties: {
            filename: { type: 'string', description: '文件名（如 report.docx）' },
            title: { type: 'string', description: '文档标题（元数据）' },
            author: { type: 'string', description: '作者' },
            defaultFont: { type: 'string', description: '默认字体，如 "Microsoft YaHei"' },
            defaultFontSize: { type: 'number', description: '默认字号（磅）' },
          },
          required: ['filename'],
        },
      },
    },
    async handler(args) {
      const filename = String(args.filename || 'document.docx');
      const state: DocState = {
        doc: null,
        sections: [],
        styles: {
          defaultFontFamily: args.defaultFont ? String(args.defaultFont) : undefined,
          defaultFontSize: args.defaultFontSize ? Number(args.defaultFontSize) : undefined,
          defaultColor: args.defaultColor ? String(args.defaultColor) : undefined,
        },
      };
      // 存储元数据，最终 save 时构建 Document
      const meta = {
        title: args.title ? String(args.title) : undefined,
        author: args.author ? String(args.author) : undefined,
      };
      const docId = sessions.create('docx', filename, { state, meta });
      return JSON.stringify({ docId, filename, message: `Word 文档已创建，使用 docId="${docId}" 进行后续操作` });
    },
  });

  // ---- doc_add_heading ----
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'doc_add_heading',
        description: '向 Word 文档添加标题。',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: '文档会话 ID' },
            text: { type: 'string', description: '标题文本' },
            level: { type: 'number', description: '标题级别 1-6，默认 1' },
            alignment: { type: 'string', enum: ['left', 'center', 'right'], description: '对齐方式' },
          },
          required: ['docId', 'text'],
        },
      },
    },
    async handler(args) {
      const { state } = sessions.require(String(args.docId), 'docx').doc as { state: DocState };
      const level = headingMap[String(args.level || '1')] || HeadingLevel.HEADING_1;
      const para = new Paragraph({
        heading: level,
        alignment: args.alignment ? alignMap[String(args.alignment)] : undefined,
        children: [
          new TextRun({
            text: String(args.text),
            font: state.styles.defaultFontFamily ? { name: state.styles.defaultFontFamily } : undefined,
          }),
        ],
      });
      state.sections.push(para);
      return JSON.stringify({ success: true, message: `标题已添加: "${args.text}"` });
    },
  });

  // ---- doc_add_paragraph ----
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'doc_add_paragraph',
        description: '向 Word 文档添加段落。支持富文本（粗体、斜体、颜色等）。',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: '文档会话 ID' },
            text: { type: 'string', description: '纯文本内容（与 runs 二选一）' },
            runs: {
              type: 'array',
              description: '富文本片段数组（与 text 二选一）',
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                  bold: { type: 'boolean' },
                  italics: { type: 'boolean' },
                  underline: { type: 'boolean' },
                  color: { type: 'string', description: '十六进制颜色如 "FF0000"' },
                  size: { type: 'number', description: '字号（磅）' },
                  font: { type: 'string', description: '字体名' },
                  highlight: { type: 'string', description: '高亮颜色' },
                  strike: { type: 'boolean' },
                  superScript: { type: 'boolean' },
                  subScript: { type: 'boolean' },
                },
                required: ['text'],
              },
            },
            alignment: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
            indent: { type: 'number', description: '首行缩进（磅）' },
            spacing: {
              type: 'object',
              properties: { before: { type: 'number' }, after: { type: 'number' }, line: { type: 'number' } },
            },
          },
          required: ['docId'],
        },
      },
    },
    async handler(args) {
      const { state } = sessions.require(String(args.docId), 'docx').doc as { state: DocState };
      const runs: TextRun[] = [];

      if (args.runs && Array.isArray(args.runs)) {
        for (const r of args.runs as Array<Record<string, unknown>>) {
          runs.push(
            new TextRun({
              text: String(r.text || ''),
              bold: r.bold as boolean | undefined,
              italics: r.italics as boolean | undefined,
              underline: r.underline ? {} : undefined,
              color: r.color ? String(r.color) : state.styles.defaultColor,
              size: r.size
                ? Number(r.size) * 2
                : state.styles.defaultFontSize
                  ? state.styles.defaultFontSize * 2
                  : undefined,
              font: r.font
                ? { name: String(r.font) }
                : state.styles.defaultFontFamily
                  ? { name: state.styles.defaultFontFamily }
                  : undefined,
              strike: r.strike as boolean | undefined,
              superScript: r.superScript as boolean | undefined,
              subScript: r.subScript as boolean | undefined,
            }),
          );
        }
      } else if (args.text) {
        runs.push(
          new TextRun({
            text: String(args.text),
            font: state.styles.defaultFontFamily ? { name: state.styles.defaultFontFamily } : undefined,
            size: state.styles.defaultFontSize ? state.styles.defaultFontSize * 2 : undefined,
          }),
        );
      }

      const spacing = args.spacing as Record<string, number> | undefined;
      const para = new Paragraph({
        children: runs,
        alignment: args.alignment ? alignMap[String(args.alignment)] : undefined,
        indent: args.indent ? { firstLine: convertInchesToTwip(Number(args.indent) / 72) } : undefined,
        spacing: spacing
          ? {
              before: spacing.before ? spacing.before * 20 : undefined,
              after: spacing.after ? spacing.after * 20 : undefined,
              line: spacing.line ? spacing.line * 240 : undefined,
            }
          : undefined,
      });
      state.sections.push(para);
      return JSON.stringify({ success: true, message: '段落已添加' });
    },
  });

  // ---- doc_add_table ----
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'doc_add_table',
        description: '向 Word 文档添加表格。',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: '文档会话 ID' },
            headers: { type: 'array', items: { type: 'string' }, description: '表头行' },
            rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: '数据行' },
            columnWidths: { type: 'array', items: { type: 'number' }, description: '列宽百分比数组' },
            headerBold: { type: 'boolean', description: '表头加粗，默认 true' },
            borders: { type: 'boolean', description: '显示边框，默认 true' },
          },
          required: ['docId', 'rows'],
        },
      },
    },
    async handler(args) {
      const { state } = sessions.require(String(args.docId), 'docx').doc as { state: DocState };
      const headers = (args.headers as string[] | undefined) || [];
      const rows = args.rows as string[][];
      const headerBold = args.headerBold !== false;
      const showBorders = args.borders !== false;

      const borderStyle = showBorders
        ? { style: BorderStyle.SINGLE, size: 1, color: '000000' }
        : { style: BorderStyle.NONE, size: 0 };
      const border = { top: borderStyle, bottom: borderStyle, left: borderStyle, right: borderStyle };

      const makeRow = (cells: string[], bold = false) =>
        new TableRow({
          children: cells.map(
            text =>
              new TableCell({
                children: [
                  new Paragraph({
                    children: [
                      new TextRun({
                        text,
                        bold,
                        font: state.styles.defaultFontFamily ? { name: state.styles.defaultFontFamily } : undefined,
                      }),
                    ],
                  }),
                ],
                borders: border,
              }),
          ),
        });

      const tableRows: TableRow[] = [];
      if (headers.length > 0) tableRows.push(makeRow(headers, headerBold));
      for (const row of rows) tableRows.push(makeRow(row));

      state.sections.push(
        new Table({
          rows: tableRows,
          width: { size: 100, type: WidthType.PERCENTAGE },
        }),
      );
      return JSON.stringify({
        success: true,
        message: `表格已添加 (${headers.length ? `${headers.length} 列` : `${rows[0]?.length} 列`}, ${rows.length} 行)`,
      });
    },
  });

  // ---- doc_add_image ----
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'doc_add_image',
        description: '向 Word 文档添加图片。支持 URL 或本地文件路径。',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: '文档会话 ID' },
            source: { type: 'string', description: '图片 URL 或本地路径' },
            width: { type: 'number', description: '宽度（像素），默认 400' },
            height: { type: 'number', description: '高度（像素），默认按比例' },
            alignment: { type: 'string', enum: ['left', 'center', 'right'] },
          },
          required: ['docId', 'source'],
        },
      },
    },
    async handler(args) {
      sessions.require(String(args.docId), 'docx');
      const { state } = sessions.get(String(args.docId))!.doc as { state: DocState };
      const { buffer } = await loadImage(String(args.source), outputDir);
      const width = Number(args.width || 400);
      const height = Number(args.height || 300);

      const para = new Paragraph({
        alignment: args.alignment ? alignMap[String(args.alignment)] : AlignmentType.CENTER,
        children: [new ImageRun({ data: buffer, transformation: { width, height }, type: 'png' })],
      });
      state.sections.push(para);
      return JSON.stringify({ success: true, message: `图片已添加 (${width}×${height})` });
    },
  });

  // ---- doc_add_list ----
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'doc_add_list',
        description: '向 Word 文档添加有序或无序列表。',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: '文档会话 ID' },
            items: { type: 'array', items: { type: 'string' }, description: '列表项' },
            ordered: { type: 'boolean', description: '是否有序列表，默认 false' },
            level: { type: 'number', description: '缩进级别 0-4，默认 0' },
          },
          required: ['docId', 'items'],
        },
      },
    },
    async handler(args) {
      const { state } = sessions.require(String(args.docId), 'docx').doc as { state: DocState };
      const items = args.items as string[];
      const ordered = !!args.ordered;
      const level = Number(args.level || 0);
      const reference = ordered ? 'aalis-ordered-list' : 'aalis-unordered-list';

      for (const item of items) {
        state.sections.push(
          new Paragraph({
            children: [
              new TextRun({
                text: item,
                font: state.styles.defaultFontFamily ? { name: state.styles.defaultFontFamily } : undefined,
              }),
            ],
            numbering: { reference, level },
          }),
        );
      }
      return JSON.stringify({ success: true, message: `${ordered ? '有序' : '无序'}列表已添加 (${items.length} 项)` });
    },
  });

  // ---- doc_add_page_break ----
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'doc_add_page_break',
        description: '在 Word 文档中插入分页符。',
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
      const { state } = sessions.require(String(args.docId), 'docx').doc as { state: DocState };
      state.sections.push(new Paragraph({ children: [new PageBreak()] }));
      return JSON.stringify({ success: true, message: '分页符已插入' });
    },
  });

  // ---- doc_add_toc ----
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'doc_add_toc',
        description: '向 Word 文档添加目录（Table of Contents）。需在 Word 中打开后更新域。',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: '文档会话 ID' },
            title: { type: 'string', description: '目录标题，默认"目录"' },
            maxLevel: { type: 'number', description: '最大标题级别，默认 3' },
          },
          required: ['docId'],
        },
      },
    },
    async handler(args) {
      const { state } = sessions.require(String(args.docId), 'docx').doc as { state: DocState };
      const title = String(args.title || '目录');
      state.sections.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: [new TextRun({ text: title })],
        }),
      );
      state.sections.push(
        new TableOfContents('TOC', {
          hyperlink: true,
          headingStyleRange: `1-${args.maxLevel || 3}`,
        }),
      );
      return JSON.stringify({ success: true, message: '目录已添加（在 Word 中打开后请更新域以显示页码）' });
    },
  });

  // ---- doc_set_header_footer ----
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'doc_set_header_footer',
        description: '设置 Word 文档的页眉和/或页脚。',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: '文档会话 ID' },
            header: { type: 'string', description: '页眉文本' },
            footer: { type: 'string', description: '页脚文本' },
            headerAlignment: { type: 'string', enum: ['left', 'center', 'right'] },
            footerAlignment: { type: 'string', enum: ['left', 'center', 'right'] },
            showPageNumber: { type: 'boolean', description: '页脚显示页码，默认 false' },
          },
          required: ['docId'],
        },
      },
    },
    async handler(args) {
      const internal = sessions.require(String(args.docId), 'docx').doc as {
        state: DocState;
        meta: Record<string, unknown>;
      };
      // 存储 header/footer 信息，在 save 时构建
      internal.meta.headerText = args.header ? String(args.header) : undefined;
      internal.meta.footerText = args.footer ? String(args.footer) : undefined;
      internal.meta.headerAlignment = args.headerAlignment ? String(args.headerAlignment) : 'center';
      internal.meta.footerAlignment = args.footerAlignment ? String(args.footerAlignment) : 'center';
      internal.meta.showPageNumber = !!args.showPageNumber;
      return JSON.stringify({ success: true, message: '页眉/页脚设置已保存' });
    },
  });

  // ---- doc_set_style ----
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'doc_set_style',
        description: '设置 Word 文档的全局样式（字体、字号、颜色、页面大小等）。影响后续添加的内容。',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: '文档会话 ID' },
            defaultFont: { type: 'string', description: '默认字体' },
            defaultFontSize: { type: 'number', description: '默认字号（磅）' },
            defaultColor: { type: 'string', description: '默认文字颜色（十六进制）' },
          },
          required: ['docId'],
        },
      },
    },
    async handler(args) {
      const { state } = sessions.require(String(args.docId), 'docx').doc as { state: DocState };
      if (args.defaultFont) state.styles.defaultFontFamily = String(args.defaultFont);
      if (args.defaultFontSize) state.styles.defaultFontSize = Number(args.defaultFontSize);
      if (args.defaultColor) state.styles.defaultColor = String(args.defaultColor);
      return JSON.stringify({ success: true, message: '样式已更新' });
    },
  });

  // ---- doc_save ----
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'doc_save',
        description:
          '保存 Word 文档到文件并释放文档会话。如果使用了子任务协作编辑，请确保所有子任务完成后再调用此工具保存。',
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
      const session = sessions.require(String(args.docId), 'docx');
      const { state, meta } = session.doc as { state: DocState; meta: Record<string, unknown> };

      // 构建 header/footer
      const headers: Record<string, Header> = {};
      const footers: Record<string, Footer> = {};

      if (meta.headerText) {
        headers.default = new Header({
          children: [
            new Paragraph({
              alignment: alignMap[String(meta.headerAlignment || 'center')],
              children: [new TextRun({ text: String(meta.headerText), italics: true, size: 18 })],
            }),
          ],
        });
      }
      if (meta.footerText || meta.showPageNumber) {
        const footerChildren: TextRun[] = [];
        if (meta.footerText) footerChildren.push(new TextRun({ text: String(meta.footerText), size: 18 }));
        footers.default = new Footer({
          children: [
            new Paragraph({
              alignment: alignMap[String(meta.footerAlignment || 'center')],
              children: footerChildren,
            }),
          ],
        });
      }

      const doc = new Document({
        title: meta.title ? String(meta.title) : undefined,
        creator: meta.author ? String(meta.author) : 'Aalis',
        numbering: {
          config: [
            {
              reference: 'aalis-ordered-list',
              levels: Array.from({ length: 5 }, (_, i) => ({
                level: i,
                format: LevelFormat.DECIMAL,
                text: `%${i + 1}.`,
                alignment: AlignmentType.LEFT,
              })),
            },
            {
              reference: 'aalis-unordered-list',
              levels: Array.from({ length: 5 }, (_, i) => ({
                level: i,
                format: LevelFormat.BULLET,
                text: '\u2022',
                alignment: AlignmentType.LEFT,
              })),
            },
          ],
        },
        sections: [
          {
            headers,
            footers,
            children: state.sections,
          },
        ],
      });

      const buffer = await Packer.toBuffer(doc);
      const filePath = resolve(outputDir, session.filename);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, buffer);
      sessions.remove(session.id);
      return JSON.stringify({ success: true, path: filePath, size: buffer.length, message: `文档已保存: ${filePath}` });
    },
  });
}
