// ============================================================
// @aalis/schema-config — 配置 Schema 词汇契约 + 词汇的中立解释
//
// 类型部分描述"配置如何呈现为表单"（label / options / textarea …）；
// 函数部分是对这套词汇的**中立解释**：默认值派生（defaultsFrom）与只读
// 结构校验（validateConfig）。两者都不属于 @aalis/core——core 只把
// `PluginModule.configSchema` 当作 opaque 数据透传，不解释任何字段。
//
// 消费方：
// - 插件：`export const configSchema: ConfigSchema = {...}` 获得形状检查
// - 渲染宿主（webui-server/client 等）：读取并渲染表单
// - 宿主政策（@aalis/runtime 的 config-sync）：按 schema 裁剪未知字段、校验告警
//
// 本包零运行时依赖：对 @aalis/core 仅有 type-only 锚点 import（编译后擦除）。
// ============================================================

/**
 * Schema 字段类型注册表 —— declaration merging 扩展点。
 *
 * 本包只内置基础类型；带业务语义的类型由对应 api 包合并声明
 * （如 `'llm-ref'` 由 @aalis/api-llm 注入）。key 即类型名，value 恒为 true。
 *
 * ```ts
 * declare module '@aalis/schema-config' {
 *   interface SchemaFieldTypes {
 *     'llm-ref': true;
 *   }
 * }
 * ```
 */
export interface SchemaFieldTypes {
  string: true;
  number: true;
  boolean: true;
  select: true;
  multiselect: true;
  textarea: true;
}

export type SchemaFieldType = keyof SchemaFieldTypes & string;

/**
 * 单个配置字段。
 *
 * 只声明所有渲染宿主共需的字段；单一宿主的交互属性
 * （如 `secret` / `dynamicOptions` / `allowCustom`）由消费它们的宿主 api 包
 * （@aalis/api-webui）通过 declaration merging 注入。
 */
export interface SchemaField {
  type: SchemaFieldType;
  label: string;
  description?: string;
  default?: unknown;
  required?: boolean;
  /** select / multiselect 类型的静态选项 */
  options?: Array<{ label: string; value: string | number }>;
  /** number：数值下限（含），validateConfig 强制。带 min 的字段建议同时声明 default——SchemaForm 对无 default 的 number 预填 0，min>0 时会撞约束 */
  min?: number;
  /** number：数值上限（含），validateConfig 强制 */
  max?: number;
  /** number：仅接受整数，validateConfig 强制 */
  integer?: boolean;
  /** number：步进——纯 UI 提示（浮点取模不可靠），validateConfig 不校验 */
  step?: number;
  /** string / textarea：正则约束（RegExp 源文本，test() 子串语义——要整串匹配请显式 ^…$），validateConfig 强制；模式本身非法则跳过该检查 */
  pattern?: string;
}

export interface SchemaGroup {
  label?: string;
  description?: string;
  fields: Record<string, SchemaField>;
}

/** 数组 Schema：对象数组，每个元素用 items 描述其字段结构 */
export interface SchemaArray {
  type: 'array';
  label: string;
  description?: string;
  /** 数组每个元素的字段定义 */
  items: Record<string, SchemaField>;
  default?: unknown[];
}

/** 配置 Schema：顶层 key 可以是字段、分组或数组 */
export type ConfigSchema = Record<string, SchemaField | SchemaGroup | SchemaArray>;

/**
 * core 基础设施配置（name / logLevel）的表单描述。
 *
 * core 自身不持有任何 schema——这份呈现层描述由本包代管，
 * 渲染宿主（webui-server 设置页）从这里取。
 */
export const CORE_CONFIG_SCHEMA: ConfigSchema = {
  name: { type: 'string', label: '应用名称', description: '应用显示名称，用于日志和界面展示', default: 'Aalis' },
  logLevel: {
    type: 'select',
    label: '日志等级',
    description: '日志输出等级',
    default: 'info',
    options: [
      { label: 'debug', value: 'debug' },
      { label: 'info', value: 'info' },
      { label: 'warn', value: 'warn' },
      { label: 'error', value: 'error' },
    ],
  },
};

/**
 * 从 ConfigSchema 派生默认配置。
 *
 * ConfigSchema 是插件配置的**唯一声明来源**：每个字段的 `default` 就是运行时默认值，
 * 不存在第二份手抄的默认值对象。宿主在注册插件前用本函数派生出默认配置
 * （经 `AppOptions.pluginDefaults` 注入 core），配置回填、恢复默认、WebUI 展示
 * 也都从这里取——一份实现，处处一致。
 *
 * 派生规则：
 * - SchemaField / SchemaArray：取 `default`（没写 default 的字段不产出键，
 *   等同于「该字段无默认值」——读取方自行处理 undefined）
 * - SchemaGroup：递归 `fields`，总是产出嵌套对象（即使子字段全无默认值）
 */
export function defaultsFrom(schema: ConfigSchema | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(schema ?? {})) {
    if (!entry || typeof entry !== 'object') continue;
    if ('fields' in entry) {
      out[key] = defaultsFrom(entry.fields);
      continue;
    }
    if ('default' in entry) out[key] = entry.default;
  }
  return out;
}

/**
 * validateConfig 发现的单条问题。path 以点号/下标定位（如 `server.port`、`hosts[2]`）。
 * kind 区分两类性质不同的问题，供调用方分级处置：
 * - `missing`：必填字段未配置——"没配全"，半成品配置的正常中间态；
 * - `invalid`：值与声明的类型/形状不符——"配错了"，任何时候都不该写入。
 */
export interface SchemaIssue {
  path: string;
  message: string;
  kind: 'missing' | 'invalid';
}

// 校验器在运行时需要一份"本包内置类型"名单：SchemaFieldTypes 是纯类型层的
// merging 注册表，运行时不存在。外来类型（如 'llm-ref'）落在名单之外，
// 校验器一律跳过放行——开放词汇表要求校验器同样开放。
const NEUTRAL_FIELD_TYPES: ReadonlySet<string> = new Set([
  'string',
  'number',
  'boolean',
  'select',
  'multiselect',
  'textarea',
]);

/**
 * 按 ConfigSchema 对配置做只读结构校验，返回问题清单（空数组 = 无问题）。
 *
 * 定位与边界：
 * - **只读**：不转换、不回填、不裁剪——那些是 defaultsFrom 与宿主政策的职责。
 *   校验器出错的最大代价必须始终是"少一条警告"，因此它绝不参与配置取值链路。
 * - **只解释中立词汇**：type/required 之外的语义（含宿主经 declaration merging
 *   注入的呈现属性，如 secret/allowCustom）一概不解读。
 * - **options 不作为取值白名单**：中立契约里 options 只是"静态选项"（呈现语义），
 *   是否允许选项外的值由宿主属性（allowCustom）决定，而本包看不见宿主属性，
 *   故 select/multiselect 只查原始类型不查成员资格。
 * - **约束键**：number 强制 min/max（含边界）与 integer，string/textarea 强制
 *   pattern（模式非法则跳过该检查）；step 是纯 UI 提示不校验。约束只在类型
 *   检查通过后评估——类型都不对时报类型错，不叠报约束错。
 * - **宽容缺失**：undefined 与 null（YAML 裸键）视为"未配置"，仅在 required 且
 *   未声明 default 时报缺——顶层/分组的默认值在调用点已合并，数组元素的默认值
 *   不参与合并（defaultsFrom 把 SchemaArray 当叶子），靠 default 声明本身放行。
 *
 * 政策留给调用方：config-sync 对启用插件打 warn（不拒载，存量脏值不打死实例；
 * 禁用插件的配置是休眠数据，不告警），webui 的 PUT 只拦**新增**的 `invalid`
 * （存量问题与 `missing` 放行——拦新不追旧，半成品配置允许落盘）。
 */
export function validateConfig(schema: ConfigSchema | undefined, config: Record<string, unknown>): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  validateFields(schema ?? {}, config, '', issues);
  return issues;
}

function validateFields(
  schema: Record<string, SchemaField | SchemaGroup | SchemaArray> | undefined,
  config: Record<string, unknown>,
  prefix: string,
  issues: SchemaIssue[],
): void {
  // `?? {}` 与 defaultsFrom 同款兜底：畸形 schema（array 缺 items / fields 为 null）
  // 不许把"最多少一条警告"升级成 TypeError——校验器自身永远不能成为故障源。
  for (const [key, entry] of Object.entries(schema ?? {})) {
    if (!entry || typeof entry !== 'object') continue;
    const path = prefix + key;
    const value = config[key];

    if ('fields' in entry) {
      if (value === undefined || value === null) continue;
      if (typeof value !== 'object' || Array.isArray(value)) {
        issues.push({ path, message: `期望对象（分组），得到 ${describeType(value)}`, kind: 'invalid' });
        continue;
      }
      validateFields(entry.fields, value as Record<string, unknown>, `${path}.`, issues);
      continue;
    }

    if (entry.type === 'array') {
      if (value === undefined || value === null) continue;
      if (!Array.isArray(value)) {
        issues.push({ path, message: `期望数组，得到 ${describeType(value)}`, kind: 'invalid' });
        continue;
      }
      value.forEach((item, i) => {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
          issues.push({ path: `${path}[${i}]`, message: `期望对象元素，得到 ${describeType(item)}`, kind: 'invalid' });
          return;
        }
        validateFields(entry.items, item as Record<string, unknown>, `${path}[${i}].`, issues);
      });
      continue;
    }

    if (value === undefined || value === null) {
      // 声明了 default 的字段永远不算缺失：顶层/分组的默认值在调用点已合并（此判恒假），
      // 数组元素的默认值不参与任何合并（defaultsFrom 把 SchemaArray 当叶子），
      // 全靠这里放行——否则 required+default 的 item 字段会误报（scheduler jobs[].platform 型）。
      if (entry.required && !('default' in entry)) issues.push({ path, message: '必填字段缺失', kind: 'missing' });
      continue;
    }
    if (!NEUTRAL_FIELD_TYPES.has(entry.type)) continue;

    switch (entry.type) {
      case 'string':
      case 'textarea':
        if (typeof value !== 'string') {
          issues.push({ path, message: `期望 string，得到 ${describeType(value)}`, kind: 'invalid' });
        } else if (entry.pattern !== undefined) {
          // 模式本身非法（作者的 schema bug）时跳过该检查——校验器不得因 schema
          // 缺陷抛错或误伤值；作者侧问题由类型检查与测试兜。
          try {
            if (!new RegExp(entry.pattern).test(value)) {
              issues.push({ path, message: `不匹配模式 ${entry.pattern}`, kind: 'invalid' });
            }
          } catch {
            /* 非法 pattern：跳过 */
          }
        }
        break;
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          issues.push({ path, message: `期望有限数值，得到 ${describeType(value)}`, kind: 'invalid' });
        } else if (entry.integer && !Number.isInteger(value)) {
          issues.push({ path, message: '期望整数', kind: 'invalid' });
        } else if (entry.min !== undefined && value < entry.min) {
          issues.push({ path, message: `小于下限 ${entry.min}`, kind: 'invalid' });
        } else if (entry.max !== undefined && value > entry.max) {
          issues.push({ path, message: `大于上限 ${entry.max}`, kind: 'invalid' });
        }
        break;
      case 'boolean':
        if (typeof value !== 'boolean')
          issues.push({ path, message: `期望 boolean，得到 ${describeType(value)}`, kind: 'invalid' });
        break;
      case 'select':
        if (typeof value !== 'string' && typeof value !== 'number') {
          issues.push({ path, message: `期望 string 或 number，得到 ${describeType(value)}`, kind: 'invalid' });
        }
        break;
      case 'multiselect':
        if (!Array.isArray(value)) {
          issues.push({ path, message: `期望数组，得到 ${describeType(value)}`, kind: 'invalid' });
        } else {
          value.forEach((item, i) => {
            if (typeof item !== 'string' && typeof item !== 'number') {
              issues.push({
                path: `${path}[${i}]`,
                message: `期望 string 或 number 元素，得到 ${describeType(item)}`,
                kind: 'invalid',
              });
            }
          });
        }
        break;
    }
  }
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return typeof value;
}

// PluginModule.configSchema 由本包经 declaration merging 挂上。
// type-only import 仅作模块增强的解析锚点，编译后擦除——本包仍是零运行时依赖。
import type {} from '@aalis/core';

// ============================================================
// PluginModule.configSchema 由本包经 declaration merging 挂上——
// core 对表单词汇零感知（词汇出核），插件拿到的却是强类型（写错
// type / 漏 label 在编译期即报），而非以前 core 声明的 opaque Record。
// ============================================================
declare module '@aalis/core' {
  interface PluginModule {
    /** 配置表单 Schema：插件配置的唯一声明来源（默认值经 defaultsFrom 派生）。 */
    configSchema?: ConfigSchema;
  }
}
