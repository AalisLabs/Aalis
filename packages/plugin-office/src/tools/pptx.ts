import type { Context } from '@aalis/core';
import PptxGenJS from 'pptxgenjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { DocSessionManager } from '../session.js';
import { loadImage } from '../utils.js';

interface PptState {
  pptx: PptxGenJS;
  slides: PptxGenJS.Slide[];
}

export function registerPptTools(ctx: Context, sessions: DocSessionManager, outputDir: string) {
  function requireState(docId: string): PptState {
    return sessions.require(docId, 'pptx').doc as PptState;
  }

  function getSlide(state: PptState, slideNumber?: number): PptxGenJS.Slide {
    const idx = (slideNumber ? slideNumber : state.slides.length) - 1;
    if (idx < 0 || idx >= state.slides.length) throw new Error(`幻灯片 ${idx + 1} 不存在`);
    return state.slides[idx];
  }

  // ---- ppt_create ----
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'ppt_create',
        description: '创建一个新的 PowerPoint 演示文稿会话，返回 docId。',
        parameters: {
          type: 'object',
          properties: {
            filename: { type: 'string', description: '文件名（如 report.pptx）' },
            title: { type: 'string', description: '演示文稿标题' },
            author: { type: 'string', description: '作者' },
            layout: { type: 'string', enum: ['LAYOUT_16x9', 'LAYOUT_4x3', 'LAYOUT_WIDE'], description: '幻灯片比例，默认 LAYOUT_16x9' },
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
      pptx.layout = String(args.layout || 'LAYOUT_16x9');
      const state: PptState = { pptx, slides: [] };
      const docId = sessions.create('pptx', filename, state);
      return JSON.stringify({ docId, filename, message: `PPT 已创建` });
    },
  });

  // ---- ppt_add_slide ----
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'ppt_add_slide',
        description: '向 PPT 添加新幻灯片。返回幻灯片编号（从 1 开始）。',
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
          },
          required: ['docId'],
        },
      },
    },
    async handler(args) {
      const state = requireState(String(args.docId));
      const opts: PptxGenJS.AddSlideProps = {};
      if (args.masterName) opts.masterName = String(args.masterName);
      const slide = state.pptx.addSlide(opts);
      const bg = args.background as Record<string, unknown> | undefined;
      if (bg?.color) slide.background = { color: String(bg.color) };
      state.slides.push(slide);
      const slideNum = state.slides.length;
      return JSON.stringify({ slideNumber: slideNum, message: `幻灯片 ${slideNum} 已添加` });
    },
  });

  // ---- ppt_add_text ----
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'ppt_add_text',
        description: '在 PPT 幻灯片上添加文本框。支持富文本（多段文字）。',
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

      const opts: PptxGenJS.TextPropsOptions = {
        x: args.x != null ? Number(args.x) : 0.5,
        y: args.y != null ? Number(args.y) : 0.5,
        w: args.w != null ? Number(args.w) : 9,
        h: args.h != null ? Number(args.h) : 1,
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

      return JSON.stringify({ success: true, message: `文本已添加到幻灯片 ${args.slideNumber || state.slides.length}` });
    },
  });

  // ---- ppt_add_image ----
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'ppt_add_image',
        description: '在 PPT 幻灯片上添加图片。支持 URL 和本地文件路径。',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: '文档会话 ID' },
            slideNumber: { type: 'number', description: '幻灯片编号' },
            source: { type: 'string', description: '图片来源：URL 或本地路径' },
            x: { type: 'number', description: 'X 位置（英寸）' },
            y: { type: 'number', description: 'Y 位置（英寸）' },
            w: { type: 'number', description: '宽度（英寸）' },
            h: { type: 'number', description: '高度（英寸）' },
          },
          required: ['docId', 'source'],
        },
      },
    },
    async handler(args) {
      const state = requireState(String(args.docId));
      const slide = getSlide(state, args.slideNumber as number | undefined);
      const { buffer, mime } = await loadImage(String(args.source), outputDir);
      const base64 = buffer.toString('base64');
      const ext = mime.includes('png') ? 'png' : mime.includes('gif') ? 'gif' : 'jpeg';

      slide.addImage({
        data: `image/${ext};base64,${base64}`,
        x: args.x != null ? Number(args.x) : 0.5,
        y: args.y != null ? Number(args.y) : 0.5,
        w: args.w != null ? Number(args.w) : 5,
        h: args.h != null ? Number(args.h) : 3.75,
      });

      return JSON.stringify({ success: true, message: `图片已添加` });
    },
  });

  // ---- ppt_add_shape ----
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'ppt_add_shape',
        description: '在 PPT 幻灯片上添加形状（矩形、圆形、箭头等）。',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: '文档会话 ID' },
            slideNumber: { type: 'number', description: '幻灯片编号' },
            shape: { type: 'string', enum: ['rect', 'ellipse', 'roundRect', 'triangle', 'diamond', 'line', 'arrow'], description: '形状类型' },
            x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
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

      const opts: PptxGenJS.ShapeProps = {
        x: args.x != null ? Number(args.x) : 1,
        y: args.y != null ? Number(args.y) : 1,
        w: args.w != null ? Number(args.w) : 2,
        h: args.h != null ? Number(args.h) : 2,
        fill: args.fill ? { color: String(args.fill) } : undefined,
        line: lineArg ? { color: lineArg.color ? String(lineArg.color) : undefined, width: lineArg.width ? Number(lineArg.width) : undefined } : undefined,
      };

      slide.addShape(shapeType, opts);

      if (args.text) {
        slide.addText(String(args.text), {
          x: opts.x, y: opts.y, w: opts.w, h: opts.h,
          align: 'center', valign: 'middle',
        });
      }

      return JSON.stringify({ success: true, message: `形状 ${args.shape} 已添加` });
    },
  });

  // ---- ppt_add_chart ----
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'ppt_add_chart',
        description: '在 PPT 幻灯片上添加图表。',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: '文档会话 ID' },
            slideNumber: { type: 'number', description: '幻灯片编号' },
            chartType: { type: 'string', enum: ['bar', 'bar3d', 'line', 'pie', 'doughnut', 'area', 'scatter'], description: '图表类型' },
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
            x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
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

      slide.addChart(type, data, {
        x: args.x != null ? Number(args.x) : 0.5,
        y: args.y != null ? Number(args.y) : 1,
        w: args.w != null ? Number(args.w) : 9,
        h: args.h != null ? Number(args.h) : 5,
        showTitle: !!args.title,
        title: args.title ? String(args.title) : undefined,
        showLegend: args.showLegend !== false,
        showValue: args.showValue === true,
      });

      return JSON.stringify({ success: true, message: `图表已添加` });
    },
  });

  // ---- ppt_add_table ----
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'ppt_add_table',
        description: '在 PPT 幻灯片上添加表格。',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: '文档会话 ID' },
            slideNumber: { type: 'number', description: '幻灯片编号' },
            headers: { type: 'array', items: { type: 'string' }, description: '表头' },
            rows: { type: 'array', items: { type: 'array', items: {} }, description: '数据行' },
            x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' },
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
        tableRows.push(headers.map(h => ({
          text: String(h),
          options: {
            bold: true,
            fill: { color: args.headerColor ? String(args.headerColor) : '4472C4' },
            color: args.headerFontColor ? String(args.headerFontColor) : 'FFFFFF',
          },
        })));
      }

      for (const row of rows) {
        tableRows.push(row.map(cell => ({ text: cell == null ? '' : String(cell) })));
      }

      slide.addTable(tableRows, {
        x: args.x != null ? Number(args.x) : 0.5,
        y: args.y != null ? Number(args.y) : 1,
        w: args.w != null ? Number(args.w) : 9,
        fontSize: args.fontSize ? Number(args.fontSize) : 12,
        border: { type: 'solid', pt: 0.5, color: 'CCCCCC' },
      });

      return JSON.stringify({ success: true, message: `表格已添加` });
    },
  });

  // ---- ppt_set_transition ----
  ctx.registerTool({
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
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'ppt_set_animation',
        description: '提示：pptxgenjs 不完全支持单个元素动画。如需动画效果，建议在 PPT 编辑器中手动设置。此工具仅作占位。',
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
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'ppt_set_master',
        description: '定义一个幻灯片母版/模板，之后可在添加幻灯片时引用。支持设置背景、标题样式、页脚等。',
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
                  x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
                  color: { type: 'string' }, fontSize: { type: 'number' }, bold: { type: 'boolean' },
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
          if (obj.type === 'text') {
            masterObjects.push({
              text: {
                text: String(obj.text || ''),
                options: {
                  x: obj.x != null ? Number(obj.x) : 0,
                  y: obj.y != null ? Number(obj.y) : 0,
                  w: obj.w != null ? Number(obj.w) : 10,
                  h: obj.h != null ? Number(obj.h) : 0.5,
                  color: obj.color ? String(obj.color) : undefined,
                  fontSize: obj.fontSize ? Number(obj.fontSize) : undefined,
                  bold: obj.bold as boolean | undefined,
                },
              },
            });
          } else if (obj.type === 'rect') {
            masterObjects.push({
              rect: {
                x: obj.x != null ? Number(obj.x) : 0,
                y: obj.y != null ? Number(obj.y) : 0,
                w: obj.w != null ? Number(obj.w) : 10,
                h: obj.h != null ? Number(obj.h) : 0.5,
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

      return JSON.stringify({ success: true, message: `母版 "${args.name}" 已定义。添加幻灯片时可通过 masterName 参数引用。` });
    },
  });

  // ---- ppt_save ----
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'ppt_save',
        description: '保存 PPT 演示文稿到文件并释放文档会话。',
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
      const filePath = resolve(outputDir, session.filename);
      mkdirSync(dirname(filePath), { recursive: true });
      const buffer = await state.pptx.write({ outputType: 'nodebuffer' }) as Buffer;
      writeFileSync(filePath, buffer);
      const slideCount = state.slides.length;
      sessions.remove(session.id);
      return JSON.stringify({ success: true, path: filePath, slides: slideCount, size: buffer.length, message: `PPT 已保存: ${filePath}` });
    },
  });
}
