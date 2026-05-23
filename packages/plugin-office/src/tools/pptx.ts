import type { StorageService } from '@aalis/plugin-storage-api';
import type { ScopedToolService } from '@aalis/plugin-tools-api';
import PptxGenJS from 'pptxgenjs';
import type { DocSessionManager } from '../session.js';
import { loadImage } from '../utils.js';

interface PptState {
  pptx: PptxGenJS;
  slides: PptxGenJS.Slide[];
  /** 幻灯片宽度（英寸） */
  slideW: number;
  /** 幻灯片高度（英寸） */
  slideH: number;
}

/** 各 layout 对应的尺寸（英寸） */
const LAYOUT_DIMS: Record<string, [number, number]> = {
  LAYOUT_16x9: [10, 5.63],
  LAYOUT_4x3: [10, 7.5],
  LAYOUT_WIDE: [13.33, 7.5],
};

/** 将元素位置/尺寸钳制在幻灯片可见区域内 */
function clampBounds(
  state: PptState,
  x?: number | null,
  y?: number | null,
  w?: number | null,
  h?: number | null,
  defaults?: { x: number; y: number; w: number; h: number },
) {
  const d = defaults || { x: 0.5, y: 0.5, w: 9, h: 1 };
  let ex = x != null ? Number(x) : d.x;
  let ey = y != null ? Number(y) : d.y;
  let ew = w != null ? Number(w) : d.w;
  let eh = h != null ? Number(h) : d.h;

  // 确保宽高不超过幻灯片尺寸
  ew = Math.min(ew, state.slideW);
  eh = Math.min(eh, state.slideH);

  // 确保 x+w 不超出右边界
  if (ex + ew > state.slideW) ex = Math.max(0, state.slideW - ew);
  // 确保 y+h 不超出下边界
  if (ey + eh > state.slideH) ey = Math.max(0, state.slideH - eh);

  // 确保起点非负
  ex = Math.max(0, ex);
  ey = Math.max(0, ey);

  return { x: ex, y: ey, w: ew, h: eh };
}

// ===== 预设模板系统 =====

interface TemplateColors {
  /** 主色调（用于标题栏、强调元素） */
  primary: string;
  /** 辅助色（用于装饰条、图标背景等） */
  secondary: string;
  /** 主文字色 */
  text: string;
  /** 背景色 */
  background: string;
  /** 标题色 */
  title: string;
  /** 副标题/浅色文字 */
  subtitle: string;
}

interface PresetTemplate {
  name: string;
  description: string;
  colors: TemplateColors;
  /** 母版定义（传给 defineSlideMaster 的参数数组） */
  masters: Array<{
    title: string;
    background: PptxGenJS.BackgroundProps;
    objects: PptxGenJS.SlideMasterProps['objects'];
  }>;
}

/**
 * 根据颜色主题生成标准母版集（title / content / section / end）
 * 所有坐标基于 16:9 (10×5.63")，创建时会自适应
 */
function buildTemplateMasters(c: TemplateColors): PresetTemplate['masters'] {
  return [
    // 封面页
    {
      title: 'title',
      background: { color: c.primary },
      objects: [
        { rect: { x: 0, y: 4.4, w: 10, h: 1.23, fill: { color: c.secondary } } },
        {
          text: {
            text: '',
            options: {
              x: 0.6,
              y: 1.2,
              w: 8.8,
              h: 1.5,
              color: c.background,
              fontSize: 36,
              bold: true,
              placeholder: 'title',
            },
          },
        },
        {
          text: {
            text: '',
            options: { x: 0.6, y: 2.9, w: 8.8, h: 0.8, color: c.subtitle, fontSize: 18, placeholder: 'subtitle' },
          },
        },
      ],
    },
    // 内容页
    {
      title: 'content',
      background: { color: c.background },
      objects: [
        { rect: { x: 0, y: 0, w: 10, h: 0.8, fill: { color: c.primary } } },
        {
          text: {
            text: '',
            options: {
              x: 0.6,
              y: 0.1,
              w: 8.8,
              h: 0.6,
              color: c.background,
              fontSize: 20,
              bold: true,
              placeholder: 'title',
            },
          },
        },
      ],
    },
    // 分节页（章节过渡）
    {
      title: 'section',
      background: { color: c.secondary },
      objects: [
        { rect: { x: 0.5, y: 2.0, w: 2, h: 0.06, fill: { color: c.background } } },
        {
          text: {
            text: '',
            options: {
              x: 0.5,
              y: 2.2,
              w: 9,
              h: 1.2,
              color: c.background,
              fontSize: 32,
              bold: true,
              placeholder: 'title',
            },
          },
        },
      ],
    },
    // 结束页
    {
      title: 'end',
      background: { color: c.primary },
      objects: [
        {
          text: {
            text: 'Thank You',
            options: { x: 0, y: 1.8, w: 10, h: 1.5, color: c.background, fontSize: 40, bold: true, align: 'center' },
          },
        },
        {
          text: {
            text: '',
            options: {
              x: 0,
              y: 3.5,
              w: 10,
              h: 0.8,
              color: c.subtitle,
              fontSize: 16,
              align: 'center',
              placeholder: 'subtitle',
            },
          },
        },
      ],
    },
  ];
}

const PRESET_TEMPLATES: Record<string, PresetTemplate> = {
  clean: {
    name: 'clean',
    description: '简洁白色主题。白底配蓝色标题栏，适合商务汇报、技术分享、日常演示等通用场景。',
    colors: {
      primary: '2B579A',
      secondary: '1A3A6B',
      text: '333333',
      background: 'FFFFFF',
      title: 'FFFFFF',
      subtitle: 'D0D8E8',
    },
    masters: buildTemplateMasters({
      primary: '2B579A',
      secondary: '1A3A6B',
      text: '333333',
      background: 'FFFFFF',
      title: 'FFFFFF',
      subtitle: 'D0D8E8',
    }),
  },
  dark: {
    name: 'dark',
    description: '深色科技主题。深蓝黑背景配亮色文字，适合科技产品发布、AI/数据、技术演讲等现代感场景。',
    colors: {
      primary: '0D1117',
      secondary: '161B22',
      text: 'E6EDF3',
      background: '0D1117',
      title: 'FFFFFF',
      subtitle: '8B949E',
    },
    masters: buildTemplateMasters({
      primary: '0D1117',
      secondary: '161B22',
      text: 'E6EDF3',
      background: '0D1117',
      title: 'FFFFFF',
      subtitle: '8B949E',
    }),
  },
  corporate: {
    name: 'corporate',
    description: '企业蓝色主题。经典蓝色调，沉稳专业，适合企业年报、战略规划、投资路演、正式汇报等商务场景。',
    colors: {
      primary: '1F4E79',
      secondary: '2E75B6',
      text: '333333',
      background: 'FFFFFF',
      title: 'FFFFFF',
      subtitle: 'BDD7EE',
    },
    masters: buildTemplateMasters({
      primary: '1F4E79',
      secondary: '2E75B6',
      text: '333333',
      background: 'FFFFFF',
      title: 'FFFFFF',
      subtitle: 'BDD7EE',
    }),
  },
  minimal: {
    name: 'minimal',
    description: '极简主题。纯白背景，黑色文字，几乎无装饰。适合学术报告、论文答辩、内容密集型演示。',
    colors: {
      primary: '222222',
      secondary: '444444',
      text: '222222',
      background: 'FFFFFF',
      title: 'FFFFFF',
      subtitle: 'AAAAAA',
    },
    masters: buildTemplateMasters({
      primary: '222222',
      secondary: '444444',
      text: '222222',
      background: 'FFFFFF',
      title: 'FFFFFF',
      subtitle: 'AAAAAA',
    }),
  },
  nature: {
    name: 'nature',
    description: '自然绿色主题。绿色调，清新自然，适合环保、农业、健康、教育等主题的演示。',
    colors: {
      primary: '2D6A4F',
      secondary: '40916C',
      text: '333333',
      background: 'FFFFFF',
      title: 'FFFFFF',
      subtitle: 'B7E4C7',
    },
    masters: buildTemplateMasters({
      primary: '2D6A4F',
      secondary: '40916C',
      text: '333333',
      background: 'FFFFFF',
      title: 'FFFFFF',
      subtitle: 'B7E4C7',
    }),
  },
  warm: {
    name: 'warm',
    description: '暖色橙红主题。温暖活泼，适合创意展示、市场营销、品牌推广、活动策划等需要活力感的场景。',
    colors: {
      primary: 'C0392B',
      secondary: 'E74C3C',
      text: '333333',
      background: 'FFFFFF',
      title: 'FFFFFF',
      subtitle: 'FADBD8',
    },
    masters: buildTemplateMasters({
      primary: 'C0392B',
      secondary: 'E74C3C',
      text: '333333',
      background: 'FFFFFF',
      title: 'FFFFFF',
      subtitle: 'FADBD8',
    }),
  },
};

/** 把预设模板的母版注册到 pptx 实例上 */
function applyTemplate(pptx: PptxGenJS, templateName: string): PresetTemplate | null {
  const tpl = PRESET_TEMPLATES[templateName];
  if (!tpl) return null;
  for (const master of tpl.masters) {
    pptx.defineSlideMaster({
      title: master.title,
      background: master.background,
      objects: master.objects,
    });
  }
  return tpl;
}

export function registerPptTools(
  tools: ScopedToolService,
  sessions: DocSessionManager,
  storage: StorageService,
  outputUri: string,
) {
  function joinUri(base: string, rel: string): string {
    const b = base.endsWith('/') ? base : `${base}/`;
    return `${b}${rel.replace(/^\/+/, '')}`;
  }
  function requireState(docId: string): PptState {
    return sessions.require(docId, 'pptx').doc as PptState;
  }

  function getSlide(state: PptState, slideNumber?: number): PptxGenJS.Slide {
    const idx = (slideNumber ? slideNumber : state.slides.length) - 1;
    if (idx < 0 || idx >= state.slides.length) throw new Error(`幻灯片 ${idx + 1} 不存在`);
    return state.slides[idx];
  }

  // ---- ppt_list_templates ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'ppt_list_templates',
        description:
          '列出所有可用的 PPT 预设模板及其描述。创建 PPT 前调用此工具了解可选模板，帮助选择最适合演示主题的模板。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    async handler() {
      const list = Object.values(PRESET_TEMPLATES).map(t => ({
        name: t.name,
        description: t.description,
        colors: { primary: t.colors.primary, text: t.colors.text, background: t.colors.background },
        masters: t.masters.map(m => m.title),
      }));
      return JSON.stringify({
        templates: list,
        message:
          '创建 PPT 时通过 template 参数指定模板名称。模板会自动注册母版（title / content / section / end），添加幻灯片时通过 masterName 参数引用。',
      });
    },
  });

  // ---- ppt_create ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'ppt_create',
        description: [
          '创建一个新的 PowerPoint 演示文稿，返回 docId。',
          '可通过 template 参数选择预设模板（如 clean/dark/corporate/minimal/nature/warm），模板会自动注册母版页。',
          '使用模板后，添加幻灯片时用 masterName 引用母版：title（封面）、content（内容）、section（分节）、end（结束）。',
          '该 docId 全局共享，可传递给子任务并行协作。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            filename: { type: 'string', description: '文件名（如 report.pptx）' },
            title: { type: 'string', description: '演示文稿标题' },
            author: { type: 'string', description: '作者' },
            layout: {
              type: 'string',
              enum: ['LAYOUT_16x9', 'LAYOUT_4x3', 'LAYOUT_WIDE'],
              description: '幻灯片比例，默认 LAYOUT_16x9',
            },
            template: {
              type: 'string',
              enum: ['clean', 'dark', 'corporate', 'minimal', 'nature', 'warm'],
              description: '预设模板名称。选择后自动注册 title/content/section/end 四种母版页',
            },
          },
          required: ['filename'],
        },
      },
    },
    async handler(args) {
      const filename = String(args.filename || 'presentation.pptx');
      const pptx = new PptxGenJS();
      if (args.title) pptx.title = String(args.title);
      if (args.author) pptx.author = String(args.author);
      const layout = String(args.layout || 'LAYOUT_16x9');
      pptx.layout = layout;
      const [slideW, slideH] = LAYOUT_DIMS[layout] || LAYOUT_DIMS.LAYOUT_16x9;

      // 应用预设模板
      let templateInfo: string | undefined;
      if (args.template) {
        const tpl = applyTemplate(pptx, String(args.template));
        if (tpl) {
          templateInfo = `已应用模板 "${tpl.name}"（${tpl.description}）。可用母版：${tpl.masters.map(m => m.title).join('、')}。颜色参考 — 主色: ${tpl.colors.primary}, 文字色: ${tpl.colors.text}, 背景色: ${tpl.colors.background}`;
        }
      }

      const state: PptState = { pptx, slides: [], slideW, slideH };
      const docId = sessions.create('pptx', filename, state);

      const result: Record<string, unknown> = {
        docId,
        filename,
        slideWidth: slideW,
        slideHeight: slideH,
        message: `PPT 已创建（${slideW}×${slideH} 英寸）。所有元素的 x/y/w/h 均以英寸为单位，请确保 x+w ≤ ${slideW}，y+h ≤ ${slideH}`,
      };
      if (templateInfo) result.template = templateInfo;
      return JSON.stringify(result);
    },
  });

  // ---- ppt_add_slide ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'ppt_add_slide',
        description: [
          '向 PPT 添加新幻灯片。返回幻灯片编号（从 1 开始）。',
          '支持 count 参数一次性批量添加多张幻灯片。',
          '',
          '【子任务协作模式】如果计划将文稿分给多个子任务并行编辑：',
          '1. 先在主会话中用 count 参数一次性预创建所有幻灯片',
          '2. 将具体的幻灯片编号范围分配给各子任务（如"负责幻灯片 1-3"）',
          '3. 子任务不应调用 ppt_add_slide，只操作已分配的幻灯片编号',
          '这样可避免并发添加导致的页面顺序混乱。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: '文档会话 ID' },
            masterName: { type: 'string', description: '母版名称（可选）' },
            background: {
              type: 'object',
              description: '幻灯片背景',
              properties: {
                color: { type: 'string', description: '背景色（十六进制如 "003366"）' },
              },
            },
            count: { type: 'number', description: '批量添加的幻灯片数量（默认 1）。用于子任务协作前预创建所有页面。' },
          },
          required: ['docId'],
        },
      },
    },
    async handler(args) {
      const state = requireState(String(args.docId));
      const count = Math.max(1, Math.min(Number(args.count) || 1, 50));
      const opts: PptxGenJS.AddSlideProps = {};
      if (args.masterName) opts.masterName = String(args.masterName);
      const bg = args.background as Record<string, unknown> | undefined;

      const added: number[] = [];
      for (let i = 0; i < count; i++) {
        const slide = state.pptx.addSlide(opts);
        if (bg?.color) slide.background = { color: String(bg.color) };
        state.slides.push(slide);
        added.push(state.slides.length);
      }

      if (count === 1) {
        return JSON.stringify({ slideNumber: added[0], message: `幻灯片 ${added[0]} 已添加` });
      }
      return JSON.stringify({
        slideNumbers: added,
        total: state.slides.length,
        message: `已批量添加 ${count} 张幻灯片（编号 ${added[0]}-${added[added.length - 1]}），共 ${state.slides.length} 张`,
      });
    },
  });

  // ---- ppt_add_text ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'ppt_add_text',
        description:
          '在 PPT 幻灯片上添加文本框。坐标/尺寸以英寸为单位，会自动钳制到幻灯片范围内。16:9 页面为 10×5.63 英寸。建议标题 y=0.3~0.5，正文 y=1.5~2，留 0.3~0.5 英寸页边距。',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: '文档会话 ID' },
            slideNumber: { type: 'number', description: '幻灯片编号（从 1 开始），默认最后一张' },
            text: { type: 'string', description: '文本内容（简单文本时使用）' },
            richText: {
              type: 'array',
              description: '富文本段落数组（与 text 二选一）',
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                  bold: { type: 'boolean' },
                  italic: { type: 'boolean' },
                  fontSize: { type: 'number', description: '字号（磅）' },
                  fontFace: { type: 'string' },
                  color: { type: 'string', description: '十六进制颜色' },
                  breakLine: { type: 'boolean', description: '后跟换行' },
                },
              },
            },
            x: { type: 'number', description: 'X 位置（英寸），默认 0.5' },
            y: { type: 'number', description: 'Y 位置（英寸），默认 0.5' },
            w: { type: 'number', description: '宽度（英寸），默认 9' },
            h: { type: 'number', description: '高度（英寸），默认 1' },
            align: { type: 'string', enum: ['left', 'center', 'right'], description: '对齐方式' },
            valign: { type: 'string', enum: ['top', 'middle', 'bottom'], description: '垂直对齐' },
            fontSize: { type: 'number', description: '默认字号' },
            fontFace: { type: 'string', description: '默认字体' },
            color: { type: 'string', description: '默认颜色' },
            bold: { type: 'boolean' },
          },
          required: ['docId'],
        },
      },
    },
    async handler(args) {
      const state = requireState(String(args.docId));
      const slide = getSlide(state, args.slideNumber as number | undefined);

      const bounds = clampBounds(state, args.x as number, args.y as number, args.w as number, args.h as number, {
        x: 0.5,
        y: 0.5,
        w: 9,
        h: 1,
      });

      const opts: PptxGenJS.TextPropsOptions = {
        ...bounds,
        align: (args.align as PptxGenJS.HAlign) || undefined,
        valign: (args.valign as PptxGenJS.VAlign) || undefined,
        fontSize: args.fontSize ? Number(args.fontSize) : undefined,
        fontFace: args.fontFace ? String(args.fontFace) : undefined,
        color: args.color ? String(args.color) : undefined,
        bold: args.bold as boolean | undefined,
      };

      const richText = args.richText as Array<Record<string, unknown>> | undefined;
      if (richText) {
        const parts: PptxGenJS.TextProps[] = richText.map(rt => ({
          text: String(rt.text || ''),
          options: {
            bold: rt.bold as boolean | undefined,
            italic: rt.italic as boolean | undefined,
            fontSize: rt.fontSize ? Number(rt.fontSize) : undefined,
            fontFace: rt.fontFace ? String(rt.fontFace) : undefined,
            color: rt.color ? String(rt.color) : undefined,
            breakLine: rt.breakLine as boolean | undefined,
          },
        }));
        slide.addText(parts, opts);
      } else {
        slide.addText(String(args.text || ''), opts);
      }

      return JSON.stringify({
        success: true,
        message: `文本已添加到幻灯片 ${args.slideNumber || state.slides.length}`,
      });
    },
  });

  // ---- ppt_add_image ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'ppt_add_image',
        description:
          '在 PPT 幻灯片上添加图片。坐标/尺寸以英寸为单位，会自动钳制到幻灯片范围内。建议图片宽度不超过 9 英寸（16:9 留边距），高度不超过 4 英寸。',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: '文档会话 ID' },
            slideNumber: { type: 'number', description: '幻灯片编号' },
            source: { type: 'string', description: '图片来源：URL 或本地路径' },
            x: { type: 'number', description: 'X 位置（英寸），默认 0.5' },
            y: { type: 'number', description: 'Y 位置（英寸），默认 0.5' },
            w: { type: 'number', description: '宽度（英寸），默认 5' },
            h: { type: 'number', description: '高度（英寸），默认 3.75' },
          },
          required: ['docId', 'source'],
        },
      },
    },
    async handler(args) {
      const state = requireState(String(args.docId));
      const slide = getSlide(state, args.slideNumber as number | undefined);
      const { buffer, mime } = await loadImage(storage, String(args.source), outputUri);
      const base64 = buffer.toString('base64');
      const ext = mime.includes('png') ? 'png' : mime.includes('gif') ? 'gif' : 'jpeg';

      const bounds = clampBounds(state, args.x as number, args.y as number, args.w as number, args.h as number, {
        x: 0.5,
        y: 0.5,
        w: 5,
        h: 3.75,
      });

      slide.addImage({
        data: `image/${ext};base64,${base64}`,
        ...bounds,
      });

      return JSON.stringify({ success: true, message: `图片已添加`, position: bounds });
    },
  });

  // ---- ppt_add_shape ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'ppt_add_shape',
        description: '在 PPT 幻灯片上添加形状（矩形、圆形、箭头等）。坐标/尺寸以英寸为单位，会自动钳制到幻灯片范围内。',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: '文档会话 ID' },
            slideNumber: { type: 'number', description: '幻灯片编号' },
            shape: {
              type: 'string',
              enum: ['rect', 'ellipse', 'roundRect', 'triangle', 'diamond', 'line', 'arrow'],
              description: '形状类型',
            },
            x: { type: 'number', description: 'X 位置（英寸），默认 1' },
            y: { type: 'number', description: 'Y 位置（英寸），默认 1' },
            w: { type: 'number', description: '宽度（英寸），默认 2' },
            h: { type: 'number', description: '高度（英寸），默认 2' },
            fill: { type: 'string', description: '填充色（十六进制）' },
            line: { type: 'object', properties: { color: { type: 'string' }, width: { type: 'number' } } },
            text: { type: 'string', description: '形状内的文字' },
          },
          required: ['docId', 'shape'],
        },
      },
    },
    async handler(args) {
      const state = requireState(String(args.docId));
      const slide = getSlide(state, args.slideNumber as number | undefined);

      const shapeMap: Record<string, PptxGenJS.ShapeType> = {
        rect: state.pptx.ShapeType.rect,
        ellipse: state.pptx.ShapeType.ellipse,
        roundRect: state.pptx.ShapeType.roundRect,
        triangle: state.pptx.ShapeType.triangle,
        diamond: state.pptx.ShapeType.diamond,
        line: state.pptx.ShapeType.line,
        arrow: state.pptx.ShapeType.rightArrow,
      };

      const shapeType = shapeMap[String(args.shape)] || state.pptx.ShapeType.rect;
      const lineArg = args.line as Record<string, unknown> | undefined;

      const bounds = clampBounds(state, args.x as number, args.y as number, args.w as number, args.h as number, {
        x: 1,
        y: 1,
        w: 2,
        h: 2,
      });

      const opts: PptxGenJS.ShapeProps = {
        ...bounds,
        fill: args.fill ? { color: String(args.fill) } : undefined,
        line: lineArg
          ? {
              color: lineArg.color ? String(lineArg.color) : undefined,
              width: lineArg.width ? Number(lineArg.width) : undefined,
            }
          : undefined,
      };

      slide.addShape(shapeType, opts);

      if (args.text) {
        slide.addText(String(args.text), {
          ...bounds,
          align: 'center',
          valign: 'middle',
        });
      }

      return JSON.stringify({ success: true, message: `形状 ${args.shape} 已添加`, position: bounds });
    },
  });

  // ---- ppt_add_chart ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'ppt_add_chart',
        description: '在 PPT 幻灯片上添加图表。坐标/尺寸以英寸为单位，会自动钳制到幻灯片范围内。',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: '文档会话 ID' },
            slideNumber: { type: 'number', description: '幻灯片编号' },
            chartType: {
              type: 'string',
              enum: ['bar', 'bar3d', 'line', 'pie', 'doughnut', 'area', 'scatter'],
              description: '图表类型',
            },
            title: { type: 'string', description: '图表标题' },
            data: {
              type: 'array',
              description: '数据系列',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: '系列名' },
                  labels: { type: 'array', items: { type: 'string' }, description: '分类标签' },
                  values: { type: 'array', items: { type: 'number' }, description: '数据值' },
                },
              },
            },
            x: { type: 'number', description: 'X 位置（英寸），默认 0.5' },
            y: { type: 'number', description: 'Y 位置（英寸），默认 1' },
            w: { type: 'number', description: '宽度（英寸），默认 9' },
            h: { type: 'number', description: '高度（英寸），默认 5' },
            showLegend: { type: 'boolean', description: '显示图例' },
            showValue: { type: 'boolean', description: '显示数值标签' },
          },
          required: ['docId', 'chartType', 'data'],
        },
      },
    },
    async handler(args) {
      const state = requireState(String(args.docId));
      const slide = getSlide(state, args.slideNumber as number | undefined);

      const chartTypeMap: Record<string, PptxGenJS.CHART_NAME> = {
        bar: state.pptx.ChartType.bar,
        bar3d: state.pptx.ChartType.bar3d,
        line: state.pptx.ChartType.line,
        pie: state.pptx.ChartType.pie,
        doughnut: state.pptx.ChartType.doughnut,
        area: state.pptx.ChartType.area,
        scatter: state.pptx.ChartType.scatter,
      };

      const type = chartTypeMap[String(args.chartType)] || state.pptx.ChartType.bar;
      const data = args.data as Array<{ name: string; labels: string[]; values: number[] }>;

      const bounds = clampBounds(state, args.x as number, args.y as number, args.w as number, args.h as number, {
        x: 0.5,
        y: 1,
        w: 9,
        h: 5,
      });

      slide.addChart(type, data, {
        ...bounds,
        showTitle: !!args.title,
        title: args.title ? String(args.title) : undefined,
        showLegend: args.showLegend !== false,
        showValue: args.showValue === true,
      });

      return JSON.stringify({ success: true, message: `图表已添加`, position: bounds });
    },
  });

  // ---- ppt_add_table ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'ppt_add_table',
        description: '在 PPT 幻灯片上添加表格。坐标/尺寸以英寸为单位，会自动钳制到幻灯片范围内。',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: '文档会话 ID' },
            slideNumber: { type: 'number', description: '幻灯片编号' },
            headers: { type: 'array', items: { type: 'string' }, description: '表头' },
            rows: { type: 'array', items: { type: 'array', items: {} }, description: '数据行' },
            x: { type: 'number', description: 'X 位置（英寸），默认 0.5' },
            y: { type: 'number', description: 'Y 位置（英寸），默认 1' },
            w: { type: 'number', description: '宽度（英寸），默认 9' },
            headerColor: { type: 'string', description: '表头背景色' },
            headerFontColor: { type: 'string', description: '表头文字颜色，默认白色' },
            fontSize: { type: 'number', description: '字号' },
          },
          required: ['docId', 'rows'],
        },
      },
    },
    async handler(args) {
      const state = requireState(String(args.docId));
      const slide = getSlide(state, args.slideNumber as number | undefined);

      const headers = args.headers as string[] | undefined;
      const rows = args.rows as unknown[][];
      const tableRows: PptxGenJS.TableRow[] = [];

      if (headers) {
        tableRows.push(
          headers.map(h => ({
            text: String(h),
            options: {
              bold: true,
              fill: { color: args.headerColor ? String(args.headerColor) : '4472C4' },
              color: args.headerFontColor ? String(args.headerFontColor) : 'FFFFFF',
            },
          })),
        );
      }

      for (const row of rows) {
        tableRows.push(row.map(cell => ({ text: cell == null ? '' : String(cell) })));
      }

      const bounds = clampBounds(state, args.x as number, args.y as number, args.w as number, undefined, {
        x: 0.5,
        y: 1,
        w: 9,
        h: 5,
      });

      slide.addTable(tableRows, {
        x: bounds.x,
        y: bounds.y,
        w: bounds.w,
        fontSize: args.fontSize ? Number(args.fontSize) : 12,
        border: { type: 'solid', pt: 0.5, color: 'CCCCCC' },
      });

      return JSON.stringify({
        success: true,
        message: `表格已添加`,
        position: { x: bounds.x, y: bounds.y, w: bounds.w },
      });
    },
  });

  // ---- ppt_set_transition ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'ppt_set_transition',
        description: '设置 PPT 幻灯片的切换效果。',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: '文档会话 ID' },
            slideNumber: { type: 'number', description: '幻灯片编号' },
            type: { type: 'string', enum: ['fade', 'push', 'wipe', 'zoom', 'none'], description: '切换类型' },
            speed: { type: 'number', description: '切换速度（秒），默认 1' },
          },
          required: ['docId', 'type'],
        },
      },
    },
    async handler(args) {
      // pptxgenjs 类型定义不暴露 transition 属性，但运行时支持
      return JSON.stringify({
        success: false,
        message: `pptxgenjs 的类型定义不支持设置幻灯片切换效果。建议在 PowerPoint 中手动设置 "${args.type}" 切换。`,
      });
    },
  });

  // ---- ppt_set_animation ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'ppt_set_animation',
        description:
          '提示：pptxgenjs 不完全支持单个元素动画。如需动画效果，建议在 PPT 编辑器中手动设置。此工具仅作占位。',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: '文档会话 ID' },
            slideNumber: { type: 'number' },
            effect: { type: 'string', enum: ['appear', 'fadeIn', 'flyIn', 'zoomIn'] },
          },
          required: ['docId', 'effect'],
        },
      },
    },
    async handler(args) {
      return JSON.stringify({
        success: false,
        message: `pptxgenjs 暂不支持单元素动画。建议在 PowerPoint 编辑器中手动为元素添加 "${args.effect}" 动画效果。幻灯片切换动画请使用 ppt_set_transition 工具。`,
      });
    },
  });

  // ---- ppt_set_master ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'ppt_set_master',
        description:
          '定义一个幻灯片母版/模板，之后可在添加幻灯片时引用。支持设置背景、固定元素等。元素坐标会自动钳制到幻灯片范围内。',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: '文档会话 ID' },
            name: { type: 'string', description: '母版名称' },
            background: { type: 'object', properties: { color: { type: 'string' } } },
            objects: {
              type: 'array',
              description: '母版上的固定元素',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['text', 'rect'] },
                  text: { type: 'string' },
                  x: { type: 'number' },
                  y: { type: 'number' },
                  w: { type: 'number' },
                  h: { type: 'number' },
                  color: { type: 'string' },
                  fontSize: { type: 'number' },
                  bold: { type: 'boolean' },
                  fill: { type: 'string' },
                },
              },
            },
          },
          required: ['docId', 'name'],
        },
      },
    },
    async handler(args) {
      const state = requireState(String(args.docId));
      const bg = args.background as Record<string, unknown> | undefined;
      const objects = args.objects as Array<Record<string, unknown>> | undefined;

      const masterObjects: PptxGenJS.SlideMasterProps['objects'] = [];
      if (objects) {
        for (const obj of objects) {
          const b = clampBounds(state, obj.x as number, obj.y as number, obj.w as number, obj.h as number, {
            x: 0,
            y: 0,
            w: state.slideW,
            h: 0.5,
          });
          if (obj.type === 'text') {
            masterObjects.push({
              text: {
                text: String(obj.text || ''),
                options: {
                  ...b,
                  color: obj.color ? String(obj.color) : undefined,
                  fontSize: obj.fontSize ? Number(obj.fontSize) : undefined,
                  bold: obj.bold as boolean | undefined,
                },
              },
            });
          } else if (obj.type === 'rect') {
            masterObjects.push({
              rect: {
                ...b,
                fill: obj.fill ? { color: String(obj.fill) } : undefined,
              },
            });
          }
        }
      }

      state.pptx.defineSlideMaster({
        title: String(args.name),
        background: bg?.color ? { color: String(bg.color) } : undefined,
        objects: masterObjects.length > 0 ? masterObjects : undefined,
      });

      return JSON.stringify({
        success: true,
        message: `母版 "${args.name}" 已定义。添加幻灯片时可通过 masterName 参数引用。`,
      });
    },
  });

  // ---- ppt_save ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'ppt_save',
        description:
          '保存 PPT 演示文稿到文件并释放文档会话。如果使用了子任务协作编辑，请确保所有子任务完成后再调用此工具保存。',
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
      const session = sessions.require(String(args.docId), 'pptx');
      const state = session.doc as PptState;
      const fileUri = joinUri(outputUri, session.filename);
      const buffer = (await state.pptx.write({ outputType: 'nodebuffer' })) as Buffer;
      await storage.writeFile(fileUri, buffer);
      const slideCount = state.slides.length;
      sessions.remove(session.id);
      return JSON.stringify({
        success: true,
        path: fileUri,
        slides: slideCount,
        size: buffer.length,
        message: `PPT 已保存: ${fileUri}`,
      });
    },
  });
}
