// ============================================================
// @aalis/plugin-config-api — 配置表单 Schema 词汇契约
//
// 这里的类型描述"配置如何呈现为表单"（label / options / textarea …），
// 是**呈现层词汇**，因此不属于 @aalis/core——core 只把 `PluginModule.configSchema`
// 当作 opaque 数据透传，不解释任何字段。
//
// 消费方：
// - 插件：`export const configSchema: ConfigSchema = {...}` 获得形状检查
// - 渲染宿主（webui-server/client 等）：读取并渲染表单
// - 宿主政策（@aalis/runtime 的 config-sync）：按 schema 裁剪未知字段
//
// 本包零依赖、纯类型 + 纯数据，不 import @aalis/core。
// ============================================================

/**
 * Schema 字段类型注册表 —— declaration merging 扩展点。
 *
 * 本包只内置基础类型；带业务语义的类型由对应 api 包合并声明
 * （如 `'llm-ref'` 由 @aalis/plugin-llm-api 注入）。key 即类型名，value 恒为 true。
 *
 * ```ts
 * declare module '@aalis/plugin-config-api' {
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
 * （@aalis/plugin-webui-api）通过 declaration merging 注入。
 */
export interface SchemaField {
  type: SchemaFieldType;
  label: string;
  description?: string;
  default?: unknown;
  required?: boolean;
  /** select / multiselect 类型的静态选项 */
  options?: Array<{ label: string; value: string | number }>;
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
