import type { StorageService } from '@aalis/plugin-storage-api';
import type { ScopedToolService } from '@aalis/plugin-tools-api';
import {
  AlignmentType,
  BorderStyle,
  convertInchesToTwip,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  type IRunOptions,
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

interface ParagraphDefaults {
  /** 首行缩进字符数（中文习惯，1 字符 ≈ 字号磅值）。0 = 不缩进。 */
  firstLineIndentChars?: number;
  /** 行距倍数（如 1.5 = 1.5 倍行距）。 */
  lineHeight?: number;
  /** 段前距（磅）。 */
  spaceBefore?: number;
  /** 段后距（磅）。 */
  spaceAfter?: number;
}

interface DocStyles {
  defaultFontFamily?: string;
  defaultFontSize?: number;
  defaultColor?: string;
  paragraphDefaults: ParagraphDefaults;
}

type SectionChildren = Paragraph | Table;

/**
 * 文档排版预设。一键应用整套样式，避免 agent 逐项配置。
 * - chinese-report: 中文报告（微软雅黑、12pt、1.5 倍行距、首行缩进 2 字符、段后 6pt）
 * - chinese-academic: 中文学术（宋体、12pt、1.5 倍行距、首行缩进 2 字符、段后 0pt）
 * - minimal: 极简（无首行缩进、1.15 倍行距）
 */
const DOC_PRESETS = {
  'chinese-report': {
    defaultFontFamily: 'Microsoft YaHei',
    defaultFontSize: 12,
    paragraphDefaults: {
      firstLineIndentChars: 2,
      lineHeight: 1.5,
      spaceBefore: 0,
      spaceAfter: 6,
    } satisfies ParagraphDefaults,
  },
  'chinese-academic': {
    defaultFontFamily: 'SimSun',
    defaultFontSize: 12,
    paragraphDefaults: {
      firstLineIndentChars: 2,
      lineHeight: 1.5,
      spaceBefore: 0,
      spaceAfter: 0,
    } satisfies ParagraphDefaults,
  },
  minimal: {
    defaultFontFamily: undefined as string | undefined,
    defaultFontSize: 11,
    paragraphDefaults: {
      firstLineIndentChars: 0,
      lineHeight: 1.15,
      spaceBefore: 0,
      spaceAfter: 6,
    } satisfies ParagraphDefaults,
  },
} as const;

type DocPresetName = keyof typeof DOC_PRESETS;

/**
 * 把含 \n 的纯文本拆成多个 TextRun，行间用 break: 1（软换行，保持同一段落）。
 * 修复 agent 传 "第一行\n第二行" 时 Word 渲染为同一行的问题。
 */
function splitTextToRuns(text: string, runOpts: Omit<IRunOptions, 'text' | 'break'>): TextRun[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  return lines.map(
    (line, i) =>
      new TextRun({
        ...runOpts,
        text: line,
        break: i > 0 ? 1 : undefined,
      }),
  );
}

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

export function registerDocxTools(
  tools: ScopedToolService,
  sessions: DocSessionManager,
  storage: StorageService,
  outputUri: string,
) {
  function joinUri(base: string, rel: string): string {
    const b = base.endsWith('/') ? base : `${base}/`;
    return `${b}${rel.replace(/^\/+/, '')}`;
  }
  // ---- doc_create ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'doc_create',
        description:
          '创建一个新的 Word 文档会话，返回 docId 用于后续操作。该 docId 全局共享，可传递给子任务实现并行协作编辑。\n' +
          '【排版建议】中文文档强烈建议传 preset="chinese-report"（自动应用：微软雅黑、12pt、1.5 倍行距、首行缩进 2 字符、段后 6pt）。' +
          '不设 preset 时 Word 会用 Times New Roman + Calibri 默认，中文混排显示不佳。',
        parameters: {
          type: 'object',
          properties: {
            filename: { type: 'string', description: '文件名（如 report.docx）' },
            title: { type: 'string', description: '文档标题（元数据）' },
            author: { type: 'string', description: '作者' },
            preset: {
              type: 'string',
              enum: ['chinese-report', 'chinese-academic', 'minimal'],
              description:
                '排版预设：chinese-report=中文报告(微软雅黑/1.5行距/首行缩进2字符/段后6pt，推荐)；chinese-academic=中文学术(宋体/1.5行距/首行缩进2字符)；minimal=极简(无缩进/1.15行距)。不传则保留 Word 空默认。',
            },
            defaultFont: { type: 'string', description: '默认字体（覆盖 preset 设置）' },
            defaultFontSize: { type: 'number', description: '默认字号（磅，覆盖 preset 设置）' },
          },
          required: ['filename'],
        },
      },
    },
    async handler(args) {
      const filename = String(args.filename || 'document.docx');
      const presetName = args.preset ? (String(args.preset) as DocPresetName) : undefined;
      const preset = presetName && presetName in DOC_PRESETS ? DOC_PRESETS[presetName] : undefined;
      const state: DocState = {
        doc: null,
        sections: [],
        styles: {
          defaultFontFamily: args.defaultFont ? String(args.defaultFont) : preset?.defaultFontFamily,
          defaultFontSize: args.defaultFontSize ? Number(args.defaultFontSize) : preset?.defaultFontSize,
          defaultColor: args.defaultColor ? String(args.defaultColor) : undefined,
          paragraphDefaults: { ...(preset?.paragraphDefaults ?? {}) },
        },
      };
      // 存储元数据，最终 save 时构建 Document
      const meta = {
        title: args.title ? String(args.title) : undefined,
        author: args.author ? String(args.author) : undefined,
      };
      const docId = sessions.create('docx', filename, { state, meta });
      return JSON.stringify({
        docId,
        filename,
        preset: presetName,
        message: `Word 文档已创建${presetName ? `（预设：${presetName}）` : ''}，使用 docId="${docId}" 进行后续操作`,
      });
    },
  });

  // ---- doc_add_heading ----
  tools.register({
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
        children: splitTextToRuns(String(args.text), {
          font: state.styles.defaultFontFamily ? { name: state.styles.defaultFontFamily } : undefined,
        }),
      });
      state.sections.push(para);
      return JSON.stringify({ success: true, message: `标题已添加: "${args.text}"` });
    },
  });

  // ---- doc_add_paragraph ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'doc_add_paragraph',
        description:
          '向 Word 文档添加段落。支持富文本（粗体、斜体、颜色等）。\n' +
          '【换行】text 或 runs[].text 中的 \\n 会自动转为软换行（同段落内的换行）。多个段落请多次调用本工具。\n' +
          '【排版】未传 alignment/indent/spacing 时，会自动应用 doc_create 的 preset 或 doc_set_style 设置的默认值。' +
          '中文正文建议：firstLineIndentChars=2（首行缩进 2 字符）、lineHeight=1.5（1.5 倍行距）、段后 6pt。',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: '文档会话 ID' },
            text: { type: 'string', description: '纯文本内容（与 runs 二选一）。支持 \\n 软换行。' },
            runs: {
              type: 'array',
              description: '富文本片段数组（与 text 二选一）。每个片段的 text 也支持 \\n 软换行。',
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
            firstLineIndentChars: {
              type: 'number',
              description: '首行缩进字符数（中文习惯，1 字符≈字号磅值；中文正文常用 2）。覆盖全局默认。',
            },
            lineHeight: {
              type: 'number',
              description: '行距倍数（1.0=单倍，1.5=1.5 倍，2.0=双倍）。覆盖全局默认。',
            },
            indent: { type: 'number', description: '首行缩进（磅，已废弃，建议改用 firstLineIndentChars）' },
            spacing: {
              type: 'object',
              description: '段落间距与行距（磅），覆盖全局默认。',
              properties: {
                before: { type: 'number', description: '段前距（磅）' },
                after: { type: 'number', description: '段后距（磅，中文正文常用 6）' },
                line: { type: 'number', description: '行距倍数（与顶层 lineHeight 等价）' },
              },
            },
          },
          required: ['docId'],
        },
      },
    },
    async handler(args) {
      const { state } = sessions.require(String(args.docId), 'docx').doc as { state: DocState };
      const runs: TextRun[] = [];

      const defaultFontOpt = state.styles.defaultFontFamily ? { name: state.styles.defaultFontFamily } : undefined;
      const defaultSizeHalf = state.styles.defaultFontSize ? state.styles.defaultFontSize * 2 : undefined;

      if (args.runs && Array.isArray(args.runs)) {
        for (const r of args.runs as Array<Record<string, unknown>>) {
          const runOpts = {
            bold: r.bold as boolean | undefined,
            italics: r.italics as boolean | undefined,
            underline: r.underline ? {} : undefined,
            color: r.color ? String(r.color) : state.styles.defaultColor,
            size: r.size ? Number(r.size) * 2 : defaultSizeHalf,
            font: r.font ? { name: String(r.font) } : defaultFontOpt,
            strike: r.strike as boolean | undefined,
            superScript: r.superScript as boolean | undefined,
            subScript: r.subScript as boolean | undefined,
            highlight: r.highlight ? (String(r.highlight) as IRunOptions['highlight']) : undefined,
          } satisfies Omit<IRunOptions, 'text' | 'break'>;
          runs.push(...splitTextToRuns(String(r.text ?? ''), runOpts));
        }
      } else if (args.text !== undefined && args.text !== null) {
        runs.push(
          ...splitTextToRuns(String(args.text), {
            font: defaultFontOpt,
            size: defaultSizeHalf,
            color: state.styles.defaultColor,
          }),
        );
      }

      // 计算行距 / 首行缩进 / 段距：调用时显式参数 > paragraphDefaults > 不设置
      const paraDef = state.styles.paragraphDefaults;
      const spacing = (args.spacing ?? {}) as Record<string, number>;
      const effLineHeight =
        typeof args.lineHeight === 'number'
          ? Number(args.lineHeight)
          : typeof spacing.line === 'number'
            ? Number(spacing.line)
            : paraDef.lineHeight;
      const effSpaceBefore = typeof spacing.before === 'number' ? Number(spacing.before) : paraDef.spaceBefore;
      const effSpaceAfter = typeof spacing.after === 'number' ? Number(spacing.after) : paraDef.spaceAfter;
      const effFirstLineChars =
        typeof args.firstLineIndentChars === 'number'
          ? Number(args.firstLineIndentChars)
          : args.indent
            ? undefined
            : paraDef.firstLineIndentChars;

      // 首行缩进：字符数 × 字号磅值 = 磅；转 twip（1 磅 = 20 twip）
      const baseFontSize = state.styles.defaultFontSize ?? 12;
      const firstLineTwip =
        effFirstLineChars && effFirstLineChars > 0
          ? Math.round(effFirstLineChars * baseFontSize * 20)
          : args.indent
            ? convertInchesToTwip(Number(args.indent) / 72)
            : undefined;

      // docx 的 spacing.line 单位是二十分之一磅；1.0 倍行距对应字号 × 20。这里以 240（12pt 单倍）为基准乘以倍数。
      const lineTwip = effLineHeight ? Math.round(effLineHeight * 240) : undefined;

      const para = new Paragraph({
        children: runs,
        alignment: args.alignment ? alignMap[String(args.alignment)] : undefined,
        indent: firstLineTwip ? { firstLine: firstLineTwip } : undefined,
        spacing:
          effSpaceBefore !== undefined || effSpaceAfter !== undefined || lineTwip !== undefined
            ? {
                before: effSpaceBefore !== undefined ? effSpaceBefore * 20 : undefined,
                after: effSpaceAfter !== undefined ? effSpaceAfter * 20 : undefined,
                line: lineTwip,
              }
            : undefined,
      });
      state.sections.push(para);
      return JSON.stringify({ success: true, message: '段落已添加' });
    },
  });

  // ---- doc_add_table ----
  tools.register({
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
                    children: splitTextToRuns(text, {
                      bold,
                      font: state.styles.defaultFontFamily ? { name: state.styles.defaultFontFamily } : undefined,
                    }),
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
  tools.register({
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
      const { buffer, mime } = await loadImage(storage, String(args.source), outputUri);
      const width = Number(args.width || 400);
      const height = Number(args.height || 300);
      // 按真实 mime 选图片类型，避免对 JPEG/GIF 硬编码 png 产出损坏 docx（对齐 pptx.ts 的处理）。
      const imgType: 'jpg' | 'gif' | 'bmp' | 'png' =
        mime.includes('jpeg') || mime.includes('jpg')
          ? 'jpg'
          : mime.includes('gif')
            ? 'gif'
            : mime.includes('bmp')
              ? 'bmp'
              : 'png';

      const para = new Paragraph({
        alignment: args.alignment ? alignMap[String(args.alignment)] : AlignmentType.CENTER,
        children: [new ImageRun({ data: buffer, transformation: { width, height }, type: imgType })],
      });
      state.sections.push(para);
      return JSON.stringify({ success: true, message: `图片已添加 (${width}×${height})` });
    },
  });

  // ---- doc_add_list ----
  tools.register({
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
            children: splitTextToRuns(item, {
              font: state.styles.defaultFontFamily ? { name: state.styles.defaultFontFamily } : undefined,
              size: state.styles.defaultFontSize ? state.styles.defaultFontSize * 2 : undefined,
            }),
            numbering: { reference, level },
          }),
        );
      }
      return JSON.stringify({ success: true, message: `${ordered ? '有序' : '无序'}列表已添加 (${items.length} 项)` });
    },
  });

  // ---- doc_add_page_break ----
  tools.register({
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
  tools.register({
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
  tools.register({
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
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'doc_set_style',
        description:
          '设置 Word 文档的全局默认样式。影响后续添加的内容；已添加的段落不受影响。\n' +
          '【典型用法】中文报告：defaultFont="Microsoft YaHei", defaultFontSize=12, defaultFirstLineIndentChars=2, defaultLineHeight=1.5, defaultSpaceAfter=6。',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: '文档会话 ID' },
            defaultFont: { type: 'string', description: '默认字体（中文常用 "Microsoft YaHei"/"SimSun"/"SimHei"）' },
            defaultFontSize: { type: 'number', description: '默认字号（磅，中文正文常用 12=小四 或 10.5=五号）' },
            defaultColor: { type: 'string', description: '默认文字颜色（十六进制如 "000000"）' },
            defaultFirstLineIndentChars: {
              type: 'number',
              description: '默认首行缩进字符数（中文正文常用 2；0=不缩进）',
            },
            defaultLineHeight: { type: 'number', description: '默认行距倍数（1.0/1.5/2.0；中文常用 1.5）' },
            defaultSpaceBefore: { type: 'number', description: '默认段前距（磅，常用 0）' },
            defaultSpaceAfter: { type: 'number', description: '默认段后距（磅，中文正文常用 6）' },
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
      const pd = state.styles.paragraphDefaults;
      if (typeof args.defaultFirstLineIndentChars === 'number') {
        pd.firstLineIndentChars = Number(args.defaultFirstLineIndentChars);
      }
      if (typeof args.defaultLineHeight === 'number') pd.lineHeight = Number(args.defaultLineHeight);
      if (typeof args.defaultSpaceBefore === 'number') pd.spaceBefore = Number(args.defaultSpaceBefore);
      if (typeof args.defaultSpaceAfter === 'number') pd.spaceAfter = Number(args.defaultSpaceAfter);
      return JSON.stringify({ success: true, message: '样式已更新', styles: { ...state.styles } });
    },
  });

  // ---- doc_save ----
  tools.register({
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
      const fileUri = joinUri(outputUri, session.filename);
      await storage.writeFile(fileUri, buffer);
      sessions.remove(session.id);
      return JSON.stringify({ success: true, path: fileUri, size: buffer.length, message: `文档已保存: ${fileUri}` });
    },
  });
}
