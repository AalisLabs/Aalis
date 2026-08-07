// ============================================================
// @aalis/schema-config — 配置表单 Schema 词汇契约
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
