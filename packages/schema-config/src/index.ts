// ============================================================
// @aalis/schema-config — 配置 Schema 词汇契约 + 词汇的中立解释
//
// 类型部分描述"配置如何呈现为表单"（label / options / textarea …），并由
// ConfigOf 从同一份 schema 推导配置值类型；
// 函数部分是对这套词汇的**中立解释**：默认值派生（defaultsFrom）与深合并（deepMergeDefaults）、
// 只读结构校验（validateConfig）、按 schema 键集裁未知字段（removeExtraFields）、
// 按 schema 解析插件拿到的配置（parseConfig）。
// 它们都不属于 @aalis/core——core 只把 `PluginMeta.configSchema` 当作
// opaque 数据透传，不解释任何字段。另有插件因配置问题无法激活时抛的错误（configError / missingConfigError）。
//
// 消费方：
// - 插件：用 defineConfig 声明 schema、放进 `definePlugin({ configSchema })`，apply 里用 parseConfig 读配置
// - 渲染宿主（webui-server/client 等）：读取并渲染表单
// - 宿主政策（@aalis/runtime 的 config-sync）：按 schema 裁剪未知字段、校验告警
//
// 本包零运行时依赖：对 @aalis/core 仅有 type-only 锚点 import（编译后擦除）。
// ============================================================

/**
 * Schema 字段类型注册表 —— declaration merging 扩展点。
 *
 * 本包只内置基础类型；带业务语义的类型由对应 api 包合并声明
 * （如 `'llm-ref'` 由 @aalis/api-llm 注入）。key 即类型名，value 是该类型的取值类型，
 * {@link ConfigOf} 据此推导配置值类型。
 *
 * ```ts
 * declare module '@aalis/schema-config' {
 *   interface SchemaFieldTypes {
 *     'llm-ref': ModelRef;
 *   }
 * }
 * ```
 *
 * 外来类型的取值不经本包校验：parseConfig 除把 `''` 当作未配置外原样透传，value 只是类型层的声明。
 */
export interface SchemaFieldTypes {
  string: string;
  number: number;
  boolean: boolean;
  /** 有静态 options、没有 dynamicOptions 且 allowCustom 不为 true 时，ConfigOf 收窄为选项值的字面量联合 */
  select: string;
  /** 有静态 options、没有 dynamicOptions 且 allowCustom 不为 true 时，ConfigOf 收窄为选项值字面量联合的数组 */
  multiselect: string[];
  textarea: string;
  /** 有序字符串列表：保序、允许重复；与 multiselect 的集合语义不同 */
  list: string[];
  /** 字符串映射，如环境变量表 */
  map: Record<string, string>;
}

export type SchemaFieldType = keyof SchemaFieldTypes & string;

/**
 * 单个配置字段。
 *
 * 声明各渲染宿主共需的字段，以及影响取值判定的属性（`dynamicOptions` / `allowCustom`）；
 * 只影响单一宿主呈现的交互属性（如 `secret`）由消费它们的宿主 api 包
 * （@aalis/api-webui）通过 declaration merging 注入。
 */
export interface SchemaField {
  type: SchemaFieldType;
  label: string;
  description?: string;
  default?: unknown;
  required?: boolean;
  /**
   * select / multiselect 类型的静态选项。没有 dynamicOptions、allowCustom 不为 true 时即取值范围：
   * 值按字符串与选项值比较，parseConfig 取选项声明的原值（数字选项存成字符串也能归位）
   */
  options?: Array<{ label: string; value: string | number }>;
  /**
   * select / multiselect 的动态选项来源：服务名（WebUI 经 webui-server 调该服务的 listModels() 或等价方法获取选项）。
   * 声明后静态 options 不再是取值范围：parseConfig / validateConfig 只查取值是字符串或数字，ConfigOf 推为 string / string[]
   */
  dynamicOptions?: string;
  /**
   * 是否允许选项之外的值。为 true 时 parseConfig / validateConfig 不查取值是否在选项内，ConfigOf 推为 string / string[]。
   * WebUI 只给 multiselect 提供手动输入；select 用它表示静态选项不全（例如由插件在运行时补全选项的字段）
   */
  allowCustom?: boolean;
  /** number：数值下限（含），validateConfig 与 parseConfig 强制。无 default 的 number 表单不预填（留空=走服务端默认），带 min 仍建议声明 default 以免长期处于缺失告警 */
  min?: number;
  /** number：数值上限（含），validateConfig 与 parseConfig 强制 */
  max?: number;
  /** number：仅接受整数，validateConfig 与 parseConfig 强制 */
  integer?: boolean;
  /** number：步进——纯 UI 提示（浮点取模不可靠），不校验 */
  step?: number;
  /** string / textarea：正则约束（RegExp 源文本，test() 子串语义——要整串匹配请显式 ^…$），validateConfig 与 parseConfig 强制；模式本身非法则跳过该检查 */
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
 * 声明插件的配置 schema：运行时原样返回传入的对象（不冻结、不加任何属性），类型层保留字面量，
 * 供 {@link ConfigOf} 推出配置值类型。返回值可直接放进 `definePlugin({ configSchema })`。
 *
 * 别给变量标 `ConfigSchema` 类型注解：注解会把字面量拓宽掉，ConfigOf 只能推出宽类型。
 * 推出的类型里各属性是只读的、options 是字面量元组；要在运行时改写 schema（WebUI 读的是这个活对象），
 * 经 `ConfigSchema` 类型的引用改写（如 `const live: ConfigSchema = configSchema`）。
 */
export function defineConfig<const S extends ConfigSchema>(schema: S): S {
  return schema;
}

/** 展开交叉类型，悬停提示显示成一个对象 */
type Flatten<T> = { [K in keyof T]: T[K] } & {};

/** parseConfig 成功后必定存在的条目：分组、required 字段、声明了 default 的字段与数组 */
type IsPresent<E> = E extends { fields: unknown }
  ? true
  : E extends { required: true }
    ? true
    : E extends { default: infer D }
      ? [D] extends [undefined]
        ? false
        : true
      : false;

type HasDynamicOptions<E> = E extends { dynamicOptions: infer D } ? ([D] extends [undefined] ? false : true) : false;

/** allowCustom 不是字面量 false 时按可能允许算：宽类型总是安全的 */
type AllowsCustom<E> = E extends { allowCustom: infer A } ? (true extends A ? true : false) : false;

type StaticOptionValue<E> = E extends { options: ReadonlyArray<{ value: infer V }> } ? V : never;

/** 有非空静态 options 且没有动态来源时收窄为选项值的字面量联合，否则取宽类型 */
type ChoiceValue<E> =
  HasDynamicOptions<E> extends true ? string : [StaticOptionValue<E>] extends [never] ? string : StaticOptionValue<E>;

type FieldValue<E> = E extends { type: 'select' }
  ? AllowsCustom<E> extends true
    ? string
    : ChoiceValue<E>
  : E extends { type: 'multiselect' }
    ? (AllowsCustom<E> extends true ? string : ChoiceValue<E>)[]
    : E extends { type: infer T extends keyof SchemaFieldTypes }
      ? SchemaFieldTypes[T]
      : unknown;

type EntryValue<E> = E extends { fields: infer F extends ConfigSchema }
  ? ConfigOf<F>
  : E extends { type: 'array'; items: infer I extends ConfigSchema }
    ? ConfigOf<I>[]
    : FieldValue<E>;

/**
 * 从 schema 推导 {@link parseConfig} 返回的配置值类型（schema 须经 {@link defineConfig} 声明才保留字面量）。
 *
 * - 字段取 {@link SchemaFieldTypes} 里登记的取值类型；select / multiselect 见该注册表的说明
 * - 有 default 或 `required: true` 的字段必定存在，其余为可选（parseConfig 省略未配置的键）
 * - 分组推为嵌套对象，总是存在；数组推为元素类型的数组，元素按同一规则推导
 */
export type ConfigOf<S extends ConfigSchema> = Flatten<
  { -readonly [K in keyof S as IsPresent<S[K]> extends true ? K : never]: EntryValue<S[K]> } & {
    -readonly [K in keyof S as IsPresent<S[K]> extends true ? never : K]?: EntryValue<S[K]>;
  }
>;

/**
 * core 基础设施配置（name / logLevel / slowThresholdMs）的表单描述。
 *
 * core 自身不持有任何 schema——这份呈现层描述由本包代管，
 * 渲染宿主（webui-server 设置页）从这里取。
 */
export const CORE_CONFIG_SCHEMA: ConfigSchema = {
  name: {
    type: 'string',
    label: '应用名称',
    description: '应用显示名称，用于启动日志和界面展示；装有人设时仪表盘仍显示它，聊天显示人设名',
    default: 'Aalis',
  },
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
  slowThresholdMs: {
    type: 'number',
    label: '慢操作阈值（毫秒）',
    description:
      '插件激活超过它仍未完成时告警并转入后台继续（它提供的服务在激活完成前不对依赖方开放），app 启动与停机阶段的单个事件监听器超过它时告警并不再等待；0 表示不设限；重启生效',
    default: 60000,
    min: 0,
  },
};

/**
 * 从 ConfigSchema 派生默认配置。
 *
 * ConfigSchema 是插件配置的**唯一声明来源**：每个字段的 `default` 就是运行时默认值，
 * 不存在第二份手抄的默认值对象。宿主在注册插件前用本函数派生出默认配置并深合并进配置文档，
 * 配置回填、恢复默认、WebUI 展示也都从这里取——一份实现，处处一致。
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
    if (isUnsafeConfigKey(key)) continue;
    if ('fields' in entry) {
      out[key] = defaultsFrom(entry.fields);
      continue;
    }
    if ('default' in entry) out[key] = cloneConfigValue(entry.default);
  }
  return out;
}

/**
 * 把默认值（通常是 {@link defaultsFrom} 的结果）深合并进配置：只填充缺失的键，已有的值（含显式 null）不覆盖。
 * 嵌套对象递归合并，只写了半块的分组照样补齐其余默认子键；数组与基础类型按「已存在则保留」处理。
 * 宿主的配置同步与 WebUI 保存插件配置用同一个合并，两条路径写出的配置形状一致。
 */
export function deepMergeDefaults(
  defaults: Record<string, unknown>,
  current: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...current };
  for (const [key, defaultValue] of Object.entries(defaults)) {
    if (!(key in result)) {
      result[key] = defaultValue;
    } else if (
      defaultValue !== null &&
      typeof defaultValue === 'object' &&
      !Array.isArray(defaultValue) &&
      result[key] !== null &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMergeDefaults(defaultValue as Record<string, unknown>, result[key] as Record<string, unknown>);
    }
  }
  return result;
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

// 校验与解析在运行时需要一份"本包内置类型"名单：SchemaFieldTypes 是纯类型层的
// merging 注册表，运行时不存在。外来类型（如 'llm-ref'）落在名单之外，
// validateConfig 一律跳过放行、parseConfig 原样透传——开放词汇表要求两者同样开放。
const NEUTRAL_FIELD_TYPES: ReadonlySet<string> = new Set([
  'string',
  'number',
  'boolean',
  'select',
  'multiselect',
  'textarea',
  'list',
  'map',
]);

/**
 * 按 ConfigSchema 对配置做只读结构校验，返回问题清单（空数组 = 无问题）。
 *
 * 定位与边界：
 * - **只读**：不转换、不回填、不裁剪——回填是 defaultsFrom，裁剪是 removeExtraFields，取值是 parseConfig。
 *   逐字段判定与 parseConfig 共用同一份：这里报 invalid 的值，parseConfig 会回落、忽略或拒绝。
 *   校验器出错的最大代价必须始终是"少一条警告"，因此它对畸形 schema 不抛错。
 * - **只解释本包的词汇**：type/required、约束键与影响取值的 dynamicOptions/allowCustom；
 *   宿主经 declaration merging 注入的呈现属性（如 secret）一概不解读。
 * - **标量宽容**：期望字符串的位置（string/textarea、list 元素、map 值、选项比较）接受有限数字；
 *   期望数字的位置接受去掉首尾空白后能完整解析为有限数的字符串。boolean 不做转换。
 * - **options 即取值范围**：select 有静态 options、没有 dynamicOptions 且 allowCustom 不为 true 时，值须是
 *   某个选项值（按字符串比较）；multiselect 同样逐元素判定。
 * - **约束键**：number 强制 min/max（含边界）与 integer，string/textarea 强制
 *   pattern（模式非法则跳过该检查）；step 是纯 UI 提示不校验。约束只在类型
 *   检查通过后评估——类型都不对时报类型错，不叠报约束错。
 * - **list / map**：list 须为数组、map 须为对象，逐元素 / 逐值报错，路径形如 `args[1]`、`env.KEY`。
 * - **宽容缺失**：undefined 与 null（YAML 裸键）视为"未配置"，required 字段的 `''` 也算未配置（WebUI 与脚手架
 *   用 `''` 表示未填，与 parseConfig 一致；空数组仍算已配置），仅在 required 且未声明 default 时报缺——顶层/分组的默认值在调用点已合并，数组元素的默认值
 *   不参与合并（defaultsFrom 把 SchemaArray 当叶子），靠 default 声明本身放行。
 *
 * 政策留给调用方：config-sync 对启用插件打 warn（禁用插件的配置是休眠数据，不告警），
 * webui 的 PUT 只拦**新增**的 `invalid`（存量问题与 `missing` 放行——拦新不追旧，半成品配置允许落盘）。
 */
export function validateConfig(schema: ConfigSchema | undefined, config: Record<string, unknown>): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  validateFields(schema ?? {}, config, '', issues);
  return issues;
}

/**
 * 按 schema 解析插件拿到的配置，返回 {@link ConfigOf} 类型的新对象（不改入参）。插件在 apply 里用它读配置：
 * `const cfg = parseConfig(configSchema, caps.config, caps.logger)`，之后的夹紧、跨字段约束等核对作用于 cfg。
 *
 * - **缺失**：undefined 与 null；required 字段另把 `''` 当作缺失（WebUI 与脚手架用 `''` 表示未填），
 *   外来类型的 `''` 一律当作缺失。有 default 用 default（拷贝），无 default 且 required 不可恢复，否则省略该键。
 * - **无效**：逐字段判定与 validateConfig 共用（标量宽容、选项即取值范围、约束键）。
 *   有 default 回落并告警；无 default 且 required 不可恢复；否则省略并告警。
 * - **外来类型**：除 `''` 外原样透传，不校验。
 * - **list / map / multiselect**：坏元素、坏值逐个丢弃并告警，其余保留。
 * - **分组**：值不是对象时告警，整组按空对象解析（子字段各取默认值）。
 * - **数组**：值不是数组按无效处理；元素不是对象、或元素内有不可恢复的字段时只丢这一条元素并告警；
 *   元素字段的默认值逐元素补齐。
 * - **schema 外的键**：丢弃并告警。
 * - **不可恢复**（顶层或分组内）：缺失抛 {@link missingConfigError}，无效抛 {@link configError}，插件随之进 error 态。
 *
 * 告警只写路径、类型名与约束，不写原值（可能是密钥）；默认值可以写。
 */
export function parseConfig<S extends ConfigSchema>(
  schema: S,
  raw: unknown,
  logger?: { warn(message: string): void },
): ConfigOf<S> {
  const warn = (message: string) => logger?.warn(message);
  let source: Record<string, unknown> = {};
  if (isRecord(raw)) source = raw;
  else if (raw !== undefined && raw !== null) warn(`配置整体期望对象，得到 ${describeType(raw)}，已忽略`);
  try {
    return parseEntries(schema, source, '', warn) as ConfigOf<S>;
  } catch (err) {
    if (!(err instanceof UnrecoverableField)) throw err;
    throw err.missing
      ? missingConfigError(err.path)
      : configError(`配置项 ${err.path} ${err.reason}，在 WebUI 或配置文件中改正后生效`);
  }
}

/**
 * 按 schema 键集裁掉未知字段。configSchema 是插件配置的**唯一声明来源**（默认值也从它派生），
 * 所以它的键集就是完整的白名单：不在 schema 里的字段，要么是用户手写的错别字，
 * 要么是已废弃的旧字段，裁掉即归位。无 schema 的插件不裁（见调用方守卫）。
 *
 * 被裁的键写入 `removed`（带点号前缀）——静默裁剪会让「字段被吃掉」与「用户没配」不可分辨。
 * `type: 'array'` 的值整段保留（数组元素结构由 validateConfig / parseConfig 解释，不在这里拆）。
 */
export function removeExtraFields(
  config: Record<string, unknown>,
  schema: Record<string, unknown>,
  removed?: string[],
  prefix = '',
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (!(key in schema)) {
      removed?.push(prefix + key);
      continue;
    }
    const schemaDef = schema[key] as Record<string, unknown>;
    if (schemaDef.type === 'array') {
      result[key] = value;
    } else if (
      schemaDef.fields &&
      typeof schemaDef.fields === 'object' &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      result[key] = removeExtraFields(
        value as Record<string, unknown>,
        schemaDef.fields as Record<string, unknown>,
        removed,
        `${prefix + key}.`,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * 配置错误：name 为 `ConfigError`，不带 stack。插件因配置缺失或不可用而无法激活时在 apply 里抛出。
 *
 * 实例照常转入 error 态，但这不是程序出错：core 的 DefaultLogger 对没有 stack 的错误只写「名称: 消息」，
 * 激活失败日志因此只有一行，不像程序崩溃。缺必填项用 {@link missingConfigError}。
 */
export function configError(message: string): Error {
  const error = new Error(message);
  error.name = 'ConfigError';
  // 定义成自有属性而不是 delete：有的引擎把 stack 做成原型上的访问器，删实例属性去不掉
  Object.defineProperty(error, 'stack', { value: undefined, writable: true, configurable: true });
  return error;
}

/**
 * 缺少必填配置时的 {@link configError}：消息点名缺的字段（`note` 是放在字段名后括号里的补充说明），并说明
 * 填入后生效——WebUI 保存或配置文件热重载会重建实例、重试激活。
 */
export function missingConfigError(field: string, note?: string): Error {
  return configError(`缺少配置项 ${field}${note ? `（${note}）` : ''}，在 WebUI 或配置文件中填入后生效`);
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
      if (!isRecord(value)) {
        issues.push({ path, message: `期望对象（分组），得到 ${describeType(value)}`, kind: 'invalid' });
        continue;
      }
      validateFields(entry.fields, value, `${path}.`, issues);
      continue;
    }

    if (entry.type === 'array') {
      if (value === undefined || value === null) continue;
      if (!Array.isArray(value)) {
        issues.push({ path, message: `期望数组，得到 ${describeType(value)}`, kind: 'invalid' });
        continue;
      }
      value.forEach((item, i) => {
        if (!isRecord(item)) {
          issues.push({ path: `${path}[${i}]`, message: `期望对象元素，得到 ${describeType(item)}`, kind: 'invalid' });
          return;
        }
        validateFields(entry.items, item, `${path}[${i}].`, issues);
      });
      continue;
    }

    if (value === undefined || value === null || (value === '' && entry.required)) {
      // 声明了 default 的字段永远不算缺失：顶层/分组的默认值多已在调用点合并，但合并不覆盖
      // 显式 null（YAML 裸键），这类值照样走到这里，
      // 数组元素的默认值不参与任何合并（defaultsFrom 把 SchemaArray 当叶子），
      // 全靠这里放行——否则 required+default 的 item 字段会误报（scheduler jobs[].platform 型）。
      if (entry.required && !('default' in entry)) issues.push({ path, message: '必填字段缺失', kind: 'missing' });
      continue;
    }
    if (!NEUTRAL_FIELD_TYPES.has(entry.type)) continue;

    const verdict = judgeField(entry, value);
    if ('invalid' in verdict) {
      issues.push({ path, message: verdict.invalid, kind: 'invalid' });
      continue;
    }
    for (const d of verdict.dropped) issues.push({ path: path + d.at, message: d.reason, kind: 'invalid' });
  }
}

// ---- 逐字段判定：validateConfig 与 parseConfig 共用 ----

/**
 * 中立类型字段对一个已配置值（非 undefined / null）的判定。`value` 是按词汇换算后的取值（数字转成的字符串、
 * 字符串转成的数字、归位后的选项值）；`dropped` 是 list / map / multiselect 里被剔除的元素，`at` 接在字段路径后。
 */
type FieldVerdict = { invalid: string } | { value: unknown; dropped: Array<{ at: string; reason: string }> };

function judgeField(field: SchemaField, value: unknown): FieldVerdict {
  switch (field.type) {
    case 'string':
    case 'textarea': {
      const text = asText(value);
      if (text === undefined) return { invalid: `期望 string，得到 ${describeType(value)}` };
      if (field.pattern !== undefined && !matchesPattern(field.pattern, text)) {
        return { invalid: `不匹配模式 ${field.pattern}` };
      }
      return { value: text, dropped: [] };
    }
    case 'number': {
      const num = asNumber(value);
      if (num === undefined) return { invalid: `期望有限数值，得到 ${describeType(value)}` };
      if (field.integer && !Number.isInteger(num)) return { invalid: '期望整数' };
      if (field.min !== undefined && num < field.min) return { invalid: `小于下限 ${field.min}` };
      if (field.max !== undefined && num > field.max) return { invalid: `大于上限 ${field.max}` };
      return { value: num, dropped: [] };
    }
    case 'boolean':
      return typeof value === 'boolean'
        ? { value, dropped: [] }
        : { invalid: `期望 boolean，得到 ${describeType(value)}` };
    case 'select': {
      const text = asText(value);
      if (text === undefined) return { invalid: `期望 string 或 number，得到 ${describeType(value)}` };
      const options = field.allowCustom === true ? undefined : choiceOptions(field);
      if (!options) return { value: text, dropped: [] };
      const hit = options.find(o => String(o.value) === text);
      return hit ? { value: hit.value, dropped: [] } : { invalid: notAnOption(options) };
    }
    case 'multiselect': {
      if (!Array.isArray(value)) return { invalid: `期望数组，得到 ${describeType(value)}` };
      const options = field.allowCustom === true ? undefined : choiceOptions(field);
      const kept: Array<string | number> = [];
      const dropped: Array<{ at: string; reason: string }> = [];
      value.forEach((item, i) => {
        const text = asText(item);
        if (text === undefined) {
          dropped.push({ at: `[${i}]`, reason: `期望 string 或 number 元素，得到 ${describeType(item)}` });
          return;
        }
        if (!options) {
          kept.push(text);
          return;
        }
        const hit = options.find(o => String(o.value) === text);
        if (hit) kept.push(hit.value);
        else dropped.push({ at: `[${i}]`, reason: notAnOption(options) });
      });
      return { value: kept, dropped };
    }
    case 'list': {
      if (!Array.isArray(value)) return { invalid: `期望数组，得到 ${describeType(value)}` };
      const kept: string[] = [];
      const dropped: Array<{ at: string; reason: string }> = [];
      value.forEach((item, i) => {
        const text = asText(item);
        if (text === undefined) dropped.push({ at: `[${i}]`, reason: `期望 string 元素，得到 ${describeType(item)}` });
        else kept.push(text);
      });
      return { value: kept, dropped };
    }
    case 'map': {
      if (!isRecord(value)) return { invalid: `期望对象（映射），得到 ${describeType(value)}` };
      const kept: Record<string, string> = {};
      const dropped: Array<{ at: string; reason: string }> = [];
      for (const [k, v] of Object.entries(value)) {
        const text = asText(v);
        if (text === undefined) dropped.push({ at: `.${k}`, reason: `期望 string 值，得到 ${describeType(v)}` });
        // 危险键不进结果对象：写 `__proto__` 会改掉结果的原型
        else if (!isUnsafeConfigKey(k)) kept[k] = text;
      }
      return { value: kept, dropped };
    }
    default:
      return { value, dropped: [] };
  }
}

/** 期望字符串的位置：字符串原样，有限数字转成字符串（YAML 里不加引号的 QQ 号、端口照常可用） */
function asText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** 期望数字的位置：有限数字原样，去掉首尾空白后非空、能完整解析为有限数的字符串转成数字（YAML 里加了引号的数字照常可用） */
function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

/** 构成取值范围的静态选项：有非空 options 且没有 dynamicOptions（动态来源的选项在运行时才知道，静态列表不完整） */
function choiceOptions(field: SchemaField): Array<{ value: string | number }> | undefined {
  if (field.dynamicOptions !== undefined || !Array.isArray(field.options)) return undefined;
  const options = field.options.filter(o => o !== null && typeof o === 'object');
  return options.length > 0 ? options : undefined;
}

function notAnOption(options: Array<{ value: string | number }>): string {
  return `不是可选值（${options.map(o => JSON.stringify(o.value)).join('、')}）之一`;
}

function matchesPattern(pattern: string, text: string): boolean {
  // 模式本身非法（作者的 schema bug）时跳过该检查——判定不得因 schema
  // 缺陷抛错或误伤值；作者侧问题由类型检查与测试兜。
  try {
    return new RegExp(pattern).test(text);
  } catch {
    return true;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return typeof value;
}

// ---- parseConfig 的遍历 ----

type Warn = (message: string) => void;

/** 顶层或分组内无法恢复的字段：parseConfig 把它转成 missingConfigError / configError 抛出，数组元素内只丢这一条元素 */
class UnrecoverableField extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
    readonly missing: boolean,
  ) {
    super(`${path} ${reason}`);
  }
}

function parseEntries(schema: unknown, source: Record<string, unknown>, prefix: string, warn: Warn) {
  // 畸形 schema（分组 fields 为 null、数组缺 items、条目为原始值）按空处理，不抛错
  const entries = isRecord(schema) ? schema : {};
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(entries)) {
    if (!isRecord(entry) || isUnsafeConfigKey(key)) continue;
    const path = prefix + key;
    // 只认自有属性：`toString` 这类键不能从原型上读到值
    const value = Object.hasOwn(source, key) ? source[key] : undefined;
    let parsed: unknown;
    if ('fields' in entry) parsed = parseGroup(entry.fields, value, path, warn);
    else if (entry.type === 'array') parsed = parseArray(entry as unknown as SchemaArray, value, path, warn);
    else parsed = parseField(entry as unknown as SchemaField, value, path, warn);
    if (parsed !== undefined) out[key] = parsed;
  }
  for (const key of Object.keys(source)) {
    if (!Object.hasOwn(entries, key)) warn(`配置项 ${prefix + key} 不在 schema 中，已忽略`);
  }
  return out;
}

function parseGroup(fields: unknown, value: unknown, path: string, warn: Warn): Record<string, unknown> {
  let source: Record<string, unknown> = {};
  if (isRecord(value)) source = value;
  else if (value !== undefined && value !== null)
    warn(`配置项 ${path} 期望对象（分组），得到 ${describeType(value)}，已忽略`);
  return parseEntries(fields, source, `${path}.`, warn);
}

function parseField(field: SchemaField, value: unknown, path: string, warn: Warn): unknown {
  const neutral = NEUTRAL_FIELD_TYPES.has(field.type);
  if (value === undefined || value === null || (value === '' && (field.required || !neutral))) {
    if (field.default !== undefined) return cloneConfigValue(field.default);
    if (field.required) throw new UnrecoverableField(path, '必填字段缺失', true);
    return undefined;
  }
  if (!neutral) return cloneConfigValue(value);
  const verdict = judgeField(field, value);
  if ('invalid' in verdict) return fallBack(field, path, verdict.invalid, warn);
  for (const d of verdict.dropped) warn(`配置项 ${path}${d.at} ${d.reason}，已忽略`);
  return verdict.value;
}

function parseArray(entry: SchemaArray, value: unknown, path: string, warn: Warn): unknown[] | undefined {
  let list: unknown = value;
  if (value === undefined || value === null) {
    list = entry.default;
  } else if (!Array.isArray(value)) {
    list = fallBack(entry, path, `期望数组，得到 ${describeType(value)}`, warn);
  }
  // 默认值同样逐元素解析：元素字段的默认值要补齐；default 本身不是数组（畸形 schema）按未配置处理
  if (!Array.isArray(list)) return undefined;
  const out: unknown[] = [];
  list.forEach((item, i) => {
    const at = `${path}[${i}]`;
    if (!isRecord(item)) {
      warn(`配置项 ${at} 已忽略：期望对象元素，得到 ${describeType(item)}`);
      return;
    }
    // 元素内的告警先攒着：这条元素整条丢弃时只报丢弃原因
    const pending: string[] = [];
    try {
      out.push(parseEntries(entry.items, item, `${at}.`, message => pending.push(message)));
    } catch (err) {
      if (!(err instanceof UnrecoverableField)) throw err;
      warn(`配置项 ${at} 已忽略：${err.path.slice(at.length + 1)} ${err.reason}`);
      return;
    }
    for (const message of pending) warn(message);
  });
  return out;
}

/** 无效值的处置：有 default 回落并告警；无 default 且 required 不可恢复；否则省略并告警 */
function fallBack(entry: { default?: unknown; required?: boolean }, path: string, reason: string, warn: Warn): unknown {
  if (entry.default !== undefined) {
    warn(`配置项 ${path} ${reason}，改用默认值 ${describeDefault(entry.default)}`);
    return cloneConfigValue(entry.default);
  }
  if (entry.required) throw new UnrecoverableField(path, reason, false);
  warn(`配置项 ${path} ${reason}，已忽略`);
  return undefined;
}

function describeDefault(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// 与 packages/core/src/infrastructure/config-values.ts 同一规则（本包零运行时依赖，不能 import core）。
// 防漂移：test/architecture/config-copy-parity.test.ts
const UNSAFE_CONFIG_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** 配置层无合法含义、落到原型链的键（`__proto__` / `constructor` / `prototype`）；宿主的配置文档按它拦 */
export function isUnsafeConfigKey(key: string): boolean {
  return UNSAFE_CONFIG_KEYS.has(key);
}

function isPlainConfigObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function cloneConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => (isPlainConfigObject(item) ? cloneConfigObject(item) : item));
  }
  if (isPlainConfigObject(value)) return cloneConfigObject(value);
  return value;
}

export function cloneConfigObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isUnsafeConfigKey(key)) continue;
    out[key] = cloneConfigValue(value);
  }
  return out;
}

// PluginMeta.configSchema 由本包经 declaration merging 挂上。
// type-only import 仅作模块增强的解析锚点，编译后擦除——本包仍是零运行时依赖。
import type {} from '@aalis/core';

// ============================================================
// PluginMeta.configSchema 由本包经 declaration merging 挂上——
// core 对表单词汇零感知（词汇出核），插件拿到的却是强类型（写错
// type / 漏 label 在编译期即报），而非以前 core 声明的 opaque Record。
// ============================================================
declare module '@aalis/core' {
  interface PluginMeta {
    /** 配置表单 Schema：插件配置的唯一声明来源（默认值经 defaultsFrom 派生）。 */
    configSchema?: ConfigSchema;
  }
}
