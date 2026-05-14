import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ScopedToolService } from '@aalis/plugin-tools-api';
import ExcelJS from 'exceljs';
import type { DocSessionManager } from '../session.js';

/** 列字母转数字 A→1, B→2, ..., Z→26, AA→27 */
function colToNum(col: string): number {
  let n = 0;
  for (const ch of col.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n;
}

/** 解析单元格地址 "A1" → { row: 1, col: 1 } */
function parseAddr(addr: string): { row: number; col: number } {
  const m = addr.match(/^([A-Za-z]+)(\d+)$/);
  if (!m) throw new Error(`无效的单元格地址: ${addr}`);
  return { col: colToNum(m[1]), row: parseInt(m[2], 10) };
}

export function registerExcelTools(tools: ScopedToolService, sessions: DocSessionManager, outputDir: string) {
  // ---- excel_create ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'excel_create',
        description:
          '创建一个新的 Excel 工作簿会话，返回 docId。默认创建一个空 Sheet。该 docId 全局共享，可传递给子任务实现并行协作编辑。',
        parameters: {
          type: 'object',
          properties: {
            filename: { type: 'string', description: '文件名（如 data.xlsx）' },
            sheetName: { type: 'string', description: '初始工作表名，默认 "Sheet1"' },
            author: { type: 'string', description: '作者' },
          },
          required: ['filename'],
        },
      },
    },
    async handler(args) {
      const filename = String(args.filename || 'workbook.xlsx');
      const wb = new ExcelJS.Workbook();
      if (args.author) wb.creator = String(args.author);
      wb.created = new Date();
      wb.addWorksheet(String(args.sheetName || 'Sheet1'));
      const docId = sessions.create('xlsx', filename, wb);
      return JSON.stringify({ docId, filename, message: `Excel 工作簿已创建` });
    },
  });

  // ---- excel_add_sheet ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'excel_add_sheet',
        description: '向 Excel 工作簿添加新的工作表。',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: '文档会话 ID' },
            name: { type: 'string', description: '工作表名称' },
            tabColor: { type: 'string', description: '标签颜色（十六进制）' },
          },
          required: ['docId', 'name'],
        },
      },
    },
    async handler(args) {
      const wb = sessions.require(String(args.docId), 'xlsx').doc as ExcelJS.Workbook;
      const opts: Partial<ExcelJS.AddWorksheetOptions> = {};
      if (args.tabColor) opts.properties = { tabColor: { argb: String(args.tabColor) } };
      wb.addWorksheet(String(args.name), opts);
      return JSON.stringify({ success: true, message: `工作表 "${args.name}" 已添加` });
    },
  });

  // ---- excel_set_cells ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'excel_set_cells',
        description: '向 Excel 工作表写入数据。支持批量设置单元格值。',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: '文档会话 ID' },
            sheet: { type: 'string', description: '工作表名称，默认第一个工作表' },
            startRow: { type: 'number', description: '起始行号（从 1 开始），默认 1' },
            startCol: { type: 'number', description: '起始列号（从 1 开始），默认 1' },
            data: {
              type: 'array',
              description: '二维数据数组，行→列',
              items: { type: 'array', items: {} },
            },
            headers: {
              type: 'array',
              description: '表头行（使用后 data 从下一行开始）',
              items: { type: 'string' },
            },
          },
          required: ['docId', 'data'],
        },
      },
    },
    async handler(args) {
      const wb = sessions.require(String(args.docId), 'xlsx').doc as ExcelJS.Workbook;
      const ws = args.sheet ? wb.getWorksheet(String(args.sheet)) : wb.worksheets[0];
      if (!ws) throw new Error(`工作表不存在: ${args.sheet || '(默认)'}`);

      let row = Number(args.startRow || 1);
      const startCol = Number(args.startCol || 1);
      const headers = args.headers as string[] | undefined;
      const data = args.data as unknown[][];

      if (headers) {
        const headerRow = ws.getRow(row);
        headers.forEach((h, i) => {
          headerRow.getCell(startCol + i).value = h;
        });
        headerRow.font = { bold: true };
        row++;
      }

      for (const rowData of data) {
        const wsRow = ws.getRow(row);
        rowData.forEach((val, i) => {
          const cell = wsRow.getCell(startCol + i);
          if (typeof val === 'number') cell.value = val;
          else if (typeof val === 'boolean') cell.value = val;
          else cell.value = val == null ? '' : String(val);
        });
        row++;
      }

      return JSON.stringify({ success: true, message: `已写入 ${headers ? data.length + 1 : data.length} 行数据` });
    },
  });

  // ---- excel_merge_cells ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'excel_merge_cells',
        description: '合并 Excel 单元格区域。',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: '文档会话 ID' },
            sheet: { type: 'string', description: '工作表名称' },
            range: { type: 'string', description: '合并范围，如 "A1:D1"' },
          },
          required: ['docId', 'range'],
        },
      },
    },
    async handler(args) {
      const wb = sessions.require(String(args.docId), 'xlsx').doc as ExcelJS.Workbook;
      const ws = args.sheet ? wb.getWorksheet(String(args.sheet)) : wb.worksheets[0];
      if (!ws) throw new Error(`工作表不存在`);
      ws.mergeCells(String(args.range));
      return JSON.stringify({ success: true, message: `已合并: ${args.range}` });
    },
  });

  // ---- excel_set_formula ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'excel_set_formula',
        description: '在 Excel 单元格中设置公式。',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: '文档会话 ID' },
            sheet: { type: 'string', description: '工作表名称' },
            cell: { type: 'string', description: '单元格地址，如 "E2"' },
            formula: { type: 'string', description: '公式（不含开头的=号），如 "SUM(A1:D1)"' },
          },
          required: ['docId', 'cell', 'formula'],
        },
      },
    },
    async handler(args) {
      const wb = sessions.require(String(args.docId), 'xlsx').doc as ExcelJS.Workbook;
      const ws = args.sheet ? wb.getWorksheet(String(args.sheet)) : wb.worksheets[0];
      if (!ws) throw new Error(`工作表不存在`);
      ws.getCell(String(args.cell)).value = { formula: String(args.formula) } as ExcelJS.CellFormulaValue;
      return JSON.stringify({ success: true, message: `公式已设置: ${args.cell} = ${args.formula}` });
    },
  });

  // ---- excel_set_style ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'excel_set_style',
        description: '设置 Excel 单元格或区域的样式（字体、填充、边框、对齐、列宽、行高等）。',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: '文档会话 ID' },
            sheet: { type: 'string', description: '工作表名称' },
            range: { type: 'string', description: '目标区域，如 "A1:D1" 或 "B2"' },
            font: {
              type: 'object',
              description: '字体设置',
              properties: {
                name: { type: 'string' },
                size: { type: 'number' },
                bold: { type: 'boolean' },
                italic: { type: 'boolean' },
                color: { type: 'string', description: 'ARGB 颜色' },
              },
            },
            fill: {
              type: 'object',
              description: '填充设置',
              properties: {
                color: { type: 'string', description: 'ARGB 颜色，如 "FF4472C4"' },
              },
            },
            alignment: {
              type: 'object',
              properties: {
                horizontal: { type: 'string', enum: ['left', 'center', 'right'] },
                vertical: { type: 'string', enum: ['top', 'middle', 'bottom'] },
                wrapText: { type: 'boolean' },
              },
            },
            border: {
              type: 'string',
              enum: ['thin', 'medium', 'thick', 'none'],
              description: '边框样式（四边统一）',
            },
            columnWidth: { type: 'number', description: '设置目标列的列宽' },
            rowHeight: { type: 'number', description: '设置目标行的行高' },
            numberFormat: { type: 'string', description: '数字格式，如 "#,##0.00" 或 "0%"' },
          },
          required: ['docId', 'range'],
        },
      },
    },
    async handler(args) {
      const wb = sessions.require(String(args.docId), 'xlsx').doc as ExcelJS.Workbook;
      const ws = args.sheet ? wb.getWorksheet(String(args.sheet)) : wb.worksheets[0];
      if (!ws) throw new Error(`工作表不存在`);

      const rangeStr = String(args.range);
      // 解析范围内的所有单元格
      const cells: ExcelJS.Cell[] = [];
      if (rangeStr.includes(':')) {
        // 区域范围
        const [start, end] = rangeStr.split(':');
        const s = parseAddr(start);
        const e = parseAddr(end);
        for (let r = s.row; r <= e.row; r++) {
          for (let c = s.col; c <= e.col; c++) {
            cells.push(ws.getCell(r, c));
          }
        }
      } else {
        cells.push(ws.getCell(rangeStr));
      }

      const fontArg = args.font as Record<string, unknown> | undefined;
      const fillArg = args.fill as Record<string, unknown> | undefined;
      const alignArg = args.alignment as Record<string, unknown> | undefined;

      for (const cell of cells) {
        if (fontArg) {
          cell.font = {
            name: fontArg.name ? String(fontArg.name) : undefined,
            size: fontArg.size ? Number(fontArg.size) : undefined,
            bold: fontArg.bold as boolean | undefined,
            italic: fontArg.italic as boolean | undefined,
            color: fontArg.color ? { argb: String(fontArg.color) } : undefined,
          };
        }
        if (fillArg?.color) {
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: String(fillArg.color) },
          };
        }
        if (alignArg) {
          cell.alignment = {
            horizontal: alignArg.horizontal as 'left' | 'center' | 'right' | undefined,
            vertical: alignArg.vertical as 'top' | 'middle' | 'bottom' | undefined,
            wrapText: alignArg.wrapText as boolean | undefined,
          };
        }
        if (args.border && args.border !== 'none') {
          const style = String(args.border) as 'thin' | 'medium' | 'thick';
          cell.border = {
            top: { style },
            bottom: { style },
            left: { style },
            right: { style },
          };
        }
        if (args.numberFormat) {
          cell.numFmt = String(args.numberFormat);
        }
      }

      if (args.columnWidth && cells.length > 0) {
        const addr = parseAddr(cells[0].address);
        ws.getColumn(addr.col).width = Number(args.columnWidth);
      }
      if (args.rowHeight && cells.length > 0) {
        const addr = parseAddr(cells[0].address);
        ws.getRow(addr.row).height = Number(args.rowHeight);
      }

      return JSON.stringify({ success: true, message: `样式已应用到 ${rangeStr}` });
    },
  });

  // ---- excel_add_chart ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'excel_add_chart',
        description:
          '提示：ExcelJS 不原生支持图表嵌入。此工具会在指定位置创建图表数据描述，建议在 Excel 中手动创建图表或使用 PPT 图表功能。',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: '文档会话 ID' },
            sheet: { type: 'string', description: '工作表名称' },
            chartType: { type: 'string', enum: ['bar', 'line', 'pie', 'scatter', 'area'], description: '图表类型' },
            dataRange: { type: 'string', description: '数据源范围，如 "A1:D10"' },
            title: { type: 'string', description: '图表标题' },
          },
          required: ['docId', 'chartType', 'dataRange'],
        },
      },
    },
    async handler(args) {
      // ExcelJS 不支持原生图表嵌入，记录信息并返回提示
      return JSON.stringify({
        success: false,
        message: `ExcelJS 暂不支持直接嵌入图表。数据已在 ${args.dataRange} 准备就绪，请在 Excel 中手动插入 ${args.chartType} 类型图表，数据源: ${args.dataRange}，标题: "${args.title || ''}"。或使用 PPT 的 ppt_add_chart 工具生成带图表的幻灯片。`,
      });
    },
  });

  // ---- excel_set_validation ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'excel_set_validation',
        description: '为 Excel 单元格区域设置数据验证（下拉列表、数值范围等）。',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: '文档会话 ID' },
            sheet: { type: 'string', description: '工作表名称' },
            range: { type: 'string', description: '目标区域，如 "B2:B100"' },
            type: { type: 'string', enum: ['list', 'whole', 'decimal', 'textLength'], description: '验证类型' },
            values: { type: 'array', items: { type: 'string' }, description: '下拉列表值（type=list 时）' },
            min: { type: 'number', description: '最小值（数值/长度验证）' },
            max: { type: 'number', description: '最大值（数值/长度验证）' },
            prompt: { type: 'string', description: '输入提示信息' },
            error: { type: 'string', description: '错误提示信息' },
          },
          required: ['docId', 'range', 'type'],
        },
      },
    },
    async handler(args) {
      const wb = sessions.require(String(args.docId), 'xlsx').doc as ExcelJS.Workbook;
      const ws = args.sheet ? wb.getWorksheet(String(args.sheet)) : wb.worksheets[0];
      if (!ws) throw new Error(`工作表不存在`);

      const validation: ExcelJS.DataValidation = {
        type: String(args.type) as 'list' | 'whole' | 'decimal' | 'textLength',
        allowBlank: true,
        formulae: [],
        showInputMessage: !!args.prompt,
        promptTitle: args.prompt ? '输入提示' : undefined,
        prompt: args.prompt ? String(args.prompt) : undefined,
        showErrorMessage: !!args.error,
        errorTitle: args.error ? '输入错误' : undefined,
        error: args.error ? String(args.error) : undefined,
      };

      if (args.type === 'list' && args.values) {
        validation.formulae = [(args.values as string[]).map(v => `"${v}"`).join(',')];
      } else if (args.min != null || args.max != null) {
        validation.operator = 'between' as ExcelJS.DataValidationOperator;
        // biome-ignore lint/suspicious/noExplicitAny: ExcelJS formulae 接受 number|string 联合数组，类型签名过严
        validation.formulae = [args.min ?? 0, args.max ?? 999999] as any[];
      }

      // 应用到范围内的所有单元格
      const [start, end] = String(args.range).includes(':')
        ? String(args.range).split(':')
        : [String(args.range), String(args.range)];
      const s = parseAddr(start);
      const e = parseAddr(end);
      for (let r = s.row; r <= e.row; r++) {
        for (let c = s.col; c <= e.col; c++) {
          ws.getCell(r, c).dataValidation = validation;
        }
      }

      return JSON.stringify({ success: true, message: `数据验证已设置: ${args.range} (${args.type})` });
    },
  });

  // ---- excel_set_conditional_format ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'excel_set_conditional_format',
        description: '为 Excel 区域设置条件格式（高亮规则、数据条等）。',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: '文档会话 ID' },
            sheet: { type: 'string', description: '工作表名称' },
            range: { type: 'string', description: '目标区域，如 "C2:C100"' },
            rule: {
              type: 'string',
              enum: ['greaterThan', 'lessThan', 'between', 'equal', 'containsText'],
              description: '规则类型',
            },
            values: { type: 'array', items: {}, description: '规则参数值（如阈值、比较值）' },
            style: {
              type: 'object',
              description: '满足条件时的样式',
              properties: {
                fontColor: { type: 'string', description: 'ARGB 颜色' },
                bgColor: { type: 'string', description: 'ARGB 颜色' },
                bold: { type: 'boolean' },
              },
            },
          },
          required: ['docId', 'range', 'rule', 'values'],
        },
      },
    },
    async handler(args) {
      const wb = sessions.require(String(args.docId), 'xlsx').doc as ExcelJS.Workbook;
      const ws = args.sheet ? wb.getWorksheet(String(args.sheet)) : wb.worksheets[0];
      if (!ws) throw new Error(`工作表不存在`);

      const style = args.style as Record<string, unknown> | undefined;
      ws.addConditionalFormatting({
        ref: String(args.range),
        rules: [
          {
            priority: 1,
            type: 'cellIs',
            // biome-ignore lint/suspicious/noExplicitAny: ExcelJS 条件格式 operator 联合类型由用户输入运行时校验
            operator: String(args.rule) as any,
            formulae: (args.values as unknown[]).map(v => String(v)),
            style: {
              font: {
                bold: style?.bold as boolean | undefined,
                color: style?.fontColor ? { argb: String(style.fontColor) } : undefined,
              },
              fill: style?.bgColor
                ? {
                    type: 'pattern',
                    pattern: 'solid',
                    bgColor: { argb: String(style.bgColor) },
                  }
                : undefined,
            },
          },
        ],
      });

      return JSON.stringify({ success: true, message: `条件格式已设置: ${args.range}` });
    },
  });

  // ---- excel_save ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'excel_save',
        description:
          '保存 Excel 工作簿到文件并释放文档会话。如果使用了子任务协作编辑，请确保所有子任务完成后再调用此工具保存。',
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
      const session = sessions.require(String(args.docId), 'xlsx');
      const wb = session.doc as ExcelJS.Workbook;
      const filePath = resolve(outputDir, session.filename);
      mkdirSync(dirname(filePath), { recursive: true });
      const buffer = await wb.xlsx.writeBuffer();
      writeFileSync(filePath, Buffer.from(buffer));
      sessions.remove(session.id);
      return JSON.stringify({
        success: true,
        path: filePath,
        size: buffer.byteLength,
        message: `Excel 已保存: ${filePath}`,
      });
    },
  });
}
