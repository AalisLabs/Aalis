// ============================================================
// @aalis/schema-config — 配置 Schema 词汇契约 + 词汇的中立解释
//
// 类型部分描述"配置如何呈现为表单"（label / options / textarea …），并由
// ConfigOf 从同一份 schema 推导配置值类型；
// 函数部分是对这套词汇的**中立解释**：默认值派生（defaultsFrom）与深合并（deepMergeDefaults）、
// 只读结构校验（validateConfig）、按 schema 键集裁未知字段（removeExtraFields）、
// 按 schema 解析插件拿到的配置（parseConfig）与单个取值的判定（readFieldValue）。
// 它们都不属于 @aalis/core——core 只把 `PluginMeta.configSchema` 当作
// opaque 数据透传，不解释任何字段。另有插件因配置问题无法激活时抛的错误（configError / missingConfigError）。
//
// 消费方：
// - 插件：用 defineConfig 声明 schema、放进 `definePlugin({ configSchema })`，apply 里用 parseConfig 读配置
// - 渲染宿主（webui-server/client 等）：读取并渲染表单
// - 宿主政策（@aalis/runtime 的 config-sync）：按 schema 裁剪未知字段、校验告警
//
// 给人看的文字（表单的 label 与说明、校验原因、配置错误）是 @aalis/schema-i18n 的文字对象，由出口按读者语言渲染。
// 运行时只依赖同样零依赖的 @aalis/schema-i18n；对 @aalis/core 仅有 type-only 锚点 import（编译后擦除）。
// ============================================================

import { isTextRef, type TextRef, withText } from '@aalis/schema-i18n';
import { t } from './texts.js';

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
 * 外来类型的取值不经本包按类型校验，只过字段自己的 validate：parseConfig 除把 `''` 当作未配置外原样透传，
 * value 只是类型层的声明。
 */
export interface SchemaFieldTypes {
  string: string;
  number: number;
  boolean: boolean;
  /** 有静态 options、没有 dynamicOptions 且 allowCustom 不为 true 时，ConfigOf 收窄为选项值的字面量联合 */
  select: string;
  /**
   * 选中的若干项，按输入顺序保留；声明了 ordered 的先后有意义且不重复。有静态 options、没有 dynamicOptions 且
   * allowCustom 不为 true 时，ConfigOf 收窄为选项值字面量联合的数组
   */
  multiselect: string[];
  textarea: string;
  /** 有序字符串列表：保序、允许重复，不限可选项 */
  list: string[];
  /** 字符串映射，如环境变量表 */
  map: Record<string, string>;
}

export type SchemaFieldType = keyof SchemaFieldTypes & string;

/** 可按会话覆盖的声明（{@link SchemaField.session}）：扩展点，成员由 @aalis/api-session-settings 经 declaration merging 并入 */
export interface SessionFieldSpec {}

/**
 * 单个配置字段。
 *
 * 声明各渲染宿主共需的字段、影响取值判定的属性（`dynamicOptions` / `allowCustom`）与各宿主都按它处理的
 * `secret`；只影响单一宿主呈现的交互属性由消费它们的宿主 api 包通过 declaration merging 注入。
 * 给人看的 label、description 与选项的 label 可以是字符串或文字对象（@aalis/schema-i18n），渲染宿主按读者语言渲染；
 * default 是取值，不是文字。
 */
export interface SchemaField {
  type: SchemaFieldType;
  label: string | TextRef;
  description?: string | TextRef;
  default?: unknown;
  required?: boolean;
  /** 显式配置的值无效时拒绝激活；缺省仍按 default / required 处理，省略时保持宽容回落 */
  onInvalid?: 'error';
  /**
   * select / multiselect 类型的静态选项。没有 dynamicOptions、allowCustom 不为 true 时即取值范围：
   * 值按字符串与选项值比较，parseConfig 取选项声明的原值（数字选项存成字符串也能归位）
   */
  options?: Array<{ label: string | TextRef; value: string | number }>;
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
  /**
   * multiselect：选中项的先后有意义（如语言的先后），呈现方据此给排序控件。为 true 时 validateConfig 与 parseConfig
   * 去掉重复项（按选项归位后的值比），重复不算问题
   */
  ordered?: boolean;
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
  /**
   * string / textarea：宿主文件路径的写法，validateConfig 与 parseConfig 强制；判定忽略首尾空白，parseConfig 交出的值也去掉首尾空白；
   * 空串与只有空白都表示未填（required 字段算缺失），不查。
   * 配置里的相对路径没有可靠的基准（宿主进程的 cwd 不带语义），所以路径一律写绝对路径：
   * - `absolute-path`：绝对路径（`/…`、`C:\…` 或 `\\…`）；
   * - `executable`：可执行文件，绝对路径或不含路径分隔符的命令名（按 PATH 查找；`C:foo` 这类带盘符的相对写法不算）。
   * 只按写法判定、与宿主平台无关：Windows 形状的绝对路径在 POSIX 宿主上也算通过。
   */
  format?: 'absolute-path' | 'executable';
  /**
   * 值是凭据（API key、token、带账号密码的连接串）。宿主不把它放在配置文档里：值存进宿主的密钥存储
   * （Node 宿主是数据目录的 `secrets.yaml`），文档里只写引用 {@link SecretRef}，交给插件之前解析回原值；
   * 展示与回传都不给原值。标在 map、list 上时整个值算一个密钥。插件照常经 parseConfig 读到原值；
   * 引用没被宿主解析（键不在密钥存储里）时 parseConfig 拒绝激活，不回落默认值。
   * `false` 与不写在运行时相同；仓内第一方的声明守卫要名字像凭据的字段写 `false` 表明判断过
   */
  secret?: boolean;
  /**
   * 可按会话覆盖：宿主不交给插件的运行态配置，插件经会话设置的读取器读；改了不重载插件。只写在顶层字段上，
   * 判定见 {@link isSessionField}
   */
  session?: SessionFieldSpec;
  /**
   * 取值校验（进程内函数，经 JSON 下发时没有）。合法返回 undefined，不合法返回原因（非空字符串或文字对象）；抛错或返回
   * 别的值都按不合法，原因写「校验时出错」。在类型与约束键之后调，拿到的是换算后的取值（外来类型是原值）；validateConfig、
   * parseConfig 与 readFieldValue 都调它。原因会原样进告警与拒绝激活的消息，不要在里面写取值（字段可能是密钥）
   */
  validate?(value: unknown): string | TextRef | undefined;
  /** 文字读成取值；内置类型不用写 */
  fromText?(text: string): unknown;
  /** 取值写成文字；内置类型不用写 */
  toText?(value: unknown): string;
}

/**
 * 配置文档里密钥字段的值：指向宿主密钥存储里的一个键。几个字段可以指向同一个键。
 * 只在 `secret: true` 的字段上有这层含义；别的字段上它只是一个普通对象。
 */
export interface SecretRef {
  $secret: string;
}

/** 是不是密钥引用：只有 `$secret` 一个自有键、值为非空字符串的纯对象 */
export function isSecretRef(value: unknown): value is SecretRef {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === '$secret' && typeof value.$secret === 'string' && value.$secret !== '';
}

/** 密钥字段在 schema 里的位置，交给 {@link mapSecretFields} 的回调 */
export interface SecretPosition {
  /** 点号路径，数组元素里的字段不带下标：`apiKey`、`auth.token`、`connections.accessToken` */
  path: string;
  /** 字段在数组元素里（同一个 path 对应多个值） */
  inArray: boolean;
}

/**
 * 逐个处理配置里密钥字段上的值（顶层、分组内、数组元素内；值为 undefined 的不处理），不改入参：有改动时返回浅拷贝
 * （没动到的部分与入参共享），没有改动时返回入参本身，调用方要改写结果请先复制。回调返回 undefined 时删掉这个键。
 * 宿主拆出、解析密钥与给呈现方去掉密钥都用它，密钥字段的位置只在这里认。
 */
export function mapSecretFields(
  schema: ConfigSchema | undefined,
  config: Record<string, unknown>,
  fn: (value: unknown, at: SecretPosition) => unknown,
): Record<string, unknown> {
  const visit = (
    fields: Record<string, unknown>,
    source: Record<string, unknown>,
    prefix: string,
    inArray: boolean,
  ): Record<string, unknown> => {
    let out = source;
    const put = (key: string, value: unknown) => {
      if (out === source) out = { ...source };
      if (value === undefined) delete out[key];
      else out[key] = value;
    };
    for (const [key, entry] of Object.entries(fields)) {
      if (!isRecord(entry) || isUnsafeConfigKey(key) || !Object.hasOwn(source, key)) continue;
      const value = source[key];
      if ('fields' in entry) {
        if (isRecord(value) && isRecord(entry.fields)) {
          const next = visit(entry.fields, value, `${prefix}${key}.`, inArray);
          if (next !== value) put(key, next);
        }
      } else if (entry.type === 'array') {
        if (Array.isArray(value) && isRecord(entry.items)) {
          const items = entry.items;
          const next = value.map(item => (isRecord(item) ? visit(items, item, `${prefix}${key}.`, true) : item));
          if (next.some((item, i) => item !== value[i])) put(key, next);
        }
      } else if (entry.secret === true && value !== undefined) {
        const next = fn(value, { path: prefix + key, inArray });
        if (next !== value) put(key, next);
      }
    }
    return out;
  };
  return visit(isRecord(schema) ? schema : {}, config, '', false);
}

export interface SchemaGroup {
  label?: string | TextRef;
  description?: string | TextRef;
  fields: Record<string, SchemaField>;
}

/** 数组 Schema：对象数组，每个元素用 items 描述其字段结构 */
export interface SchemaArray {
  type: 'array';
  label: string | TextRef;
  description?: string | TextRef;
  /** 数组每个元素的字段定义 */
  items: Record<string, SchemaField>;
  default?: unknown[];
  /** 遇到非对象元素或元素内不可恢复的字段时拒绝整个数组；默认只丢弃该元素。 */
  onInvalid?: 'error';
}

/** 配置 Schema：顶层 key 可以是字段、分组或数组 */
export type ConfigSchema = Record<string, SchemaField | SchemaGroup | SchemaArray>;

/** 经 JSON 下发的字段：去掉函数成员，session 原样保留 */
export type WireSchemaField = Omit<SchemaField, 'validate' | 'fromText' | 'toText'>;

/** 经 JSON 下发的 schema：同 {@link ConfigSchema}，分组与数组元素里的字段也换成 {@link WireSchemaField} */
export type WireConfigSchema = Record<
  string,
  | WireSchemaField
  | (Omit<SchemaGroup, 'fields'> & { fields: Record<string, WireSchemaField> })
  | (Omit<SchemaArray, 'items'> & { items: Record<string, WireSchemaField> })
>;

/**
 * 顶层条目是不是可按会话覆盖的字段：是字段（不是分组、数组）且 session 不为 undefined。只对 configSchema 的顶层条目问，
 * 分组与数组元素里的字段不按它判
 */
export function isSessionField(entry: unknown): entry is SchemaField & { session: SessionFieldSpec } {
  return isRecord(entry) && !('fields' in entry) && entry.type !== 'array' && entry.session !== undefined;
}

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

/** 条目声明了 K（不是 undefined） */
type Declares<E, K extends string> = E extends { [P in K]: infer D } ? ([D] extends [undefined] ? false : true) : false;

/** parseConfig 成功后必定存在的条目：分组、required 字段、声明了 default 的字段与数组 */
type IsPresent<E> = E extends { fields: unknown } ? true : E extends { required: true } ? true : Declares<E, 'default'>;

/** 带 session 的顶层字段的键（{@link isSessionField} 的类型层）：分组、数组上写了不算，写成 undefined 不算 */
type SessionKeys<S> = {
  [K in keyof S]: S[K] extends { fields: unknown } | { type: 'array' }
    ? never
    : Declares<S[K], 'session'> extends true
      ? K
      : never;
}[keyof S];

/** allowCustom 不是字面量 false 时按可能允许算：宽类型总是安全的 */
type AllowsCustom<E> = E extends { allowCustom: infer A } ? (true extends A ? true : false) : false;

type StaticOptionValue<E> = E extends { options: ReadonlyArray<{ value: infer V }> } ? V : never;

/** 有非空静态 options 且没有动态来源时收窄为选项值的字面量联合，否则取宽类型 */
type ChoiceValue<E> =
  Declares<E, 'dynamicOptions'> extends true
    ? string
    : [StaticOptionValue<E>] extends [never]
      ? string
      : StaticOptionValue<E>;

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
  ? EntriesOf<F>
  : E extends { type: 'array'; items: infer I extends ConfigSchema }
    ? EntriesOf<I>[]
    : FieldValue<E>;

/** 各条目解析出的值：分组与数组元素也用它，带 session 的字段只在顶层由 ConfigOf 排除 */
type EntriesOf<S> = Flatten<
  { -readonly [K in keyof S as IsPresent<S[K]> extends true ? K : never]: EntryValue<S[K]> } & {
    -readonly [K in keyof S as IsPresent<S[K]> extends true ? never : K]?: EntryValue<S[K]>;
  }
>;

/**
 * 从 schema 推导 {@link parseConfig} 返回的配置值类型（schema 须经 {@link defineConfig} 声明才保留字面量）。
 *
 * - 字段取 {@link SchemaFieldTypes} 里登记的取值类型；select / multiselect 见该注册表的说明
 * - 有 default 或 `required: true` 的字段必定存在，其余为可选（parseConfig 省略未配置的键）
 * - 分组推为嵌套对象，总是存在；数组推为元素类型的数组，元素按同一规则推导
 * - 带 session 的顶层字段不在其中（parseConfig 不交出），见 {@link SessionFieldsOf}
 */
export type ConfigOf<S extends ConfigSchema> = EntriesOf<Omit<S, SessionKeys<S>>>;

/** 带 session 的字段经会话设置读到的值：严格字段的坏值原样交出、不往下回落，所以是 unknown */
type SessionValue<E> = E extends { onInvalid: 'error' } ? unknown : FieldValue<E>;

/**
 * 从 schema 推导带 session 的顶层字段经会话设置的读取器读到的值（ConfigOf 不含的那部分）。
 *
 * - 取值类型同 ConfigOf；`onInvalid: 'error'` 的为 unknown，由插件自己核
 * - 有 default 的必定存在，没有的为可选（哪层都没设时没有值）
 */
export type SessionFieldsOf<S extends ConfigSchema> = Flatten<
  { [K in SessionKeys<S> as Declares<S[K], 'default'> extends true ? K : never]: SessionValue<S[K]> } & {
    [K in SessionKeys<S> as Declares<S[K], 'default'> extends true ? never : K]?: SessionValue<S[K]>;
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
    label: t('nameLabel'),
    description: t('nameDescription'),
    default: 'Aalis',
  },
  logLevel: {
    type: 'select',
    label: t('logLevelLabel'),
    description: t('logLevelDescription'),
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
    label: t('slowThresholdLabel'),
    description: t('slowThresholdDescription'),
    default: 60000,
    min: 0,
  },
};

/**
 * 宿主配置里只在启动时读、改了要重启才生效的核心键：runtime 启动时读它们交给 core，WebUI 设置页据此标「重启后生效」。
 * runtime 改了哪些键只在启动时读，同步改这一份。name 只是显示用的应用名称，保存即生效
 */
export const CORE_RESTART_KEYS: readonly string[] = ['logLevel', 'slowThresholdMs'];

/**
 * 从 ConfigSchema 派生默认配置（密钥字段除外）。
 *
 * ConfigSchema 是插件配置的**唯一声明来源**：每个字段的 `default` 就是运行时默认值，
 * 不存在第二份手抄的默认值对象。宿主在注册插件前用本函数派生出默认配置并深合并进配置文档，
 * 配置回填、恢复默认、WebUI 展示也都从这里取——一份实现，处处一致。
 *
 * 派生规则：
 * - SchemaField / SchemaArray：取 `default`（没写 default 的字段不产出键，
 *   等同于「该字段无默认值」——读取方自行处理 undefined）
 * - SchemaGroup：递归 `fields`，总是产出嵌套对象（即使子字段全无默认值）
 * - `secret: true` 的字段不产出：派生结果会被写进配置文档，密钥的默认值不进文档（map 的默认值还会被深合并进
 *   引用对象），插件经 parseConfig 照常补上
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
    if ((entry as SchemaField).secret === true) continue;
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
    if (!Object.hasOwn(result, key)) {
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
 * 校验问题的原因种类：
 * - `missing`：必填却没配；
 * - `type`：类型或形状不符（如期望字符串却是对象、期望数组却是字符串）；
 * - `not-option`：不是可选值；`pattern`：不匹配正则；`format`：路径的写法不符；
 * - `integer`、`min`、`max`：数值约束；`reserved-key`：映射里用了保留键；
 * - `validate`：字段自己的 validate 判为不合法（含它抛错）。
 */
export type SchemaIssueCode =
  | 'missing'
  | 'type'
  | 'not-option'
  | 'pattern'
  | 'format'
  | 'integer'
  | 'min'
  | 'max'
  | 'reserved-key'
  | 'validate';

/**
 * validateConfig 发现的单条问题。path 以点号/下标定位（如 `server.port`、`hosts[2]`）。
 * kind 区分两类性质不同的问题，供调用方分级处置：
 * - `missing`：必填字段未配置——"没配全"，半成品配置的正常中间态；
 * - `invalid`：值与声明的类型/形状不符——"配错了"，任何时候都不该写入。
 *
 * 原因：code 给程序判断，text 是本包字典的文字对象（出口按读者语言渲染），message 是它的原文（日志用）。
 */
export interface SchemaIssue {
  path: string;
  message: string;
  kind: 'missing' | 'invalid';
  code: SchemaIssueCode;
  text: TextRef;
}

// 校验与解析在运行时需要一份"本包内置类型"名单：SchemaFieldTypes 是纯类型层的
// merging 注册表，运行时不存在。外来类型（如 'llm-ref'）落在名单之外，不经类型判定、只过字段自己的 validate：
// validateConfig 放行、parseConfig 原样透传——开放词汇表要求两者同样开放。
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
 * 字段类型是不是本包内置的：内置类型的取值经 validateConfig 与 parseConfig 按类型校验，外来类型（如 'llm-ref'）的
 * 只过字段的 validate
 */
export function isBuiltinFieldType(type: string): boolean {
  return NEUTRAL_FIELD_TYPES.has(type);
}

/**
 * 按 ConfigSchema 对配置做只读结构校验，返回问题清单（空数组 = 无问题）。
 *
 * 定位与边界：
 * - **只读**：不转换、不回填、不裁剪——回填是 defaultsFrom，裁剪是 removeExtraFields，取值是 parseConfig。
 *   逐字段判定与 parseConfig 共用同一份：这里报 invalid 的值，parseConfig 会回落、忽略或拒绝（带 session 的顶层字段除外，
 *   parseConfig 不交出它）。
 *   校验器出错的最大代价必须始终是"少一条警告"，因此它对畸形 schema 不抛错。
 * - **只解释本包的词汇**：type/required、约束键、影响取值的 dynamicOptions/allowCustom、secret 与字段自己的 validate；
 *   宿主经 declaration merging 注入的呈现属性一概不解读。带 session 的字段照常校验（它的全局层就在配置文档里）。
 * - **校验的是文档**：`secret` 字段上的 {@link SecretRef} 算合法（值在宿主的密钥存储里），不查引用的键在不在。
 * - **标量宽容**：期望字符串的位置（string/textarea、list 元素、map 值、选项比较）接受有限数字；
 *   期望数字的位置接受去掉首尾空白后能完整解析为有限数的字符串。boolean 不做转换。
 * - **options 即取值范围**：select 有静态 options、没有 dynamicOptions 且 allowCustom 不为 true 时，值须是
 *   某个选项值（按字符串比较）；multiselect 同样逐元素判定。
 * - **约束键**：number 强制 min/max（含边界）与 integer，string/textarea 强制
 *   pattern（模式非法则跳过该检查）与 format（空串与只有空白不查）；step 是纯 UI 提示不校验。约束只在类型
 *   检查通过后评估——类型都不对时报类型错，不叠报约束错。
 * - **validate**：类型与约束键都过了才调，拿换算后的取值；返回原因报 invalid（code 为 `validate`），抛错同样报，不外传。
 *   list、map、multiselect 有坏元素时只报元素、不调它：它拿到的会是剔掉坏元素的值，报的原因对不上文档里写的。
 * - **list / map**：list 须为数组、map 须为对象，逐元素 / 逐值报错，路径形如 `args[1]`、`env.KEY`。
 * - **宽容缺失**：undefined 与 null（YAML 裸键）视为"未配置"，required 字段的 `''` 也算未配置（WebUI 与脚手架
 *   用 `''` 表示未填，与 parseConfig 一致；声明了 format 的只有空白也算；空数组仍算已配置），仅在 required 且未声明 default 时报缺——顶层/分组的默认值在调用点已合并，数组元素的默认值
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
 * - **缺失**：undefined 与 null；required 字段另把 `''` 当作缺失（WebUI 与脚手架用 `''` 表示未填；声明了 format 的
 *   只有空白也算），外来类型的 `''` 一律当作缺失。有 default 用 default（拷贝），无 default 且 required 不可恢复，否则省略该键。
 * - **无效**：逐字段判定与 validateConfig 共用（标量宽容、选项即取值范围、约束键、字段的 validate）。
 *   list、map、multiselect 先丢坏元素，validate 判的是剩下的值。
 *   默认有 default 回落并告警；无 default 且 required 不可恢复；否则省略并告警。
 *   `onInvalid: 'error'` 的字段遇到显式无效值或坏集合成员时，即使有 default 也不可恢复。
 * - **外来类型**：除 `''` 外原样透传，只过字段的 validate。
 * - **带 session 的顶层字段**：不交出、不补 default，配置里有这个键也不告警（插件经会话设置的读取器读）。
 * - **密钥字段**：宿主交给插件之前已把引用解析成原值；`secret` 字段上仍是 {@link SecretRef}，说明引用的键不在
 *   宿主的密钥存储里，一律不可恢复（不回落 default，数组元素里的也不只丢这一条），消息点名键名。owner 写了引用，
 *   引用落空就是配置错误，回落默认值会悄悄连上别的东西（例如默认的本机数据库）。
 * - **list / map / multiselect**：默认坏元素、坏值逐个丢弃并告警；严格字段拒绝整个值。
 * - **分组**：值不是对象时默认告警并按空对象解析；含严格字段时拒绝显式无效的分组值。
 * - **数组**：值不是数组按无效处理，含严格元素字段时拒绝显式无效的数组值；元素不是对象、或元素内有不可恢复的字段时只丢这一条元素并告警；
 *   数组自身声明 `onInvalid: 'error'` 时不丢元素而是拒绝整个数组。元素字段的默认值逐元素补齐。
 * - **schema 外的键**：丢弃并告警。
 * - **不可恢复**（顶层或分组内）：缺失抛 {@link missingConfigError}，无效抛 {@link configError}，插件随之进 error 态。
 *
 * 告警只写路径、类型名与约束，不写原值（可能是密钥）；默认值可以写。字段 validate 返回的原因原样写进去。
 */
export function parseConfig<S extends ConfigSchema>(
  schema: S,
  raw: unknown,
  logger?: { warn(message: string): void },
): ConfigOf<S> {
  const warn = (message: string) => logger?.warn(message);
  let source: Record<string, unknown> = {};
  if (isRecord(raw)) source = raw;
  else if (raw !== undefined && raw !== null) {
    if (hasStrictField(schema, true)) throw configError(t('notObject'));
    warn(`配置整体期望对象，得到 ${describeType(raw)}，已忽略`);
  }
  try {
    return parseEntries(schema, source, '', warn) as ConfigOf<S>;
  } catch (err) {
    if (!(err instanceof UnrecoverableField)) throw err;
    throw err.missing
      ? missingConfigError(err.path)
      : configError(t('invalid', { path: err.path, reason: err.reason }));
  }
}

/**
 * 单个字段对一个值的判定，与 validateConfig 同一套（类型、约束键、字段的 validate）：合法给出换算后的取值，没配置的
 * （undefined、null，外来类型与 required 字段的空串）给 `{ value: undefined }`；不合法给出原因，list、map、multiselect
 * 里有元素不合法也算（取第一个）。不回落 default、不抛错，不拷贝（外来类型的值原样交出）。判的是取值本身：密钥字段上的
 * 引用不像 validateConfig 那样按文档的写法放行
 */
export function readFieldValue(field: SchemaField, value: unknown): { value: unknown } | { invalid: TextRef } {
  if (isUnset(field, value)) return { value: undefined };
  const verdict = judgeField(field, value);
  if ('invalid' in verdict) return { invalid: verdict.invalid.text };
  const [dropped] = verdict.dropped;
  if (dropped) return { invalid: dropped.reason.text };
  const invalid = runValidate(field, verdict.value);
  return invalid ? { invalid: invalid.text } : { value: verdict.value };
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
    // 只认 schema 的自有键：配置里的 toString、valueOf 这类键不能靠原型上的同名属性逃过裁剪
    if (!Object.hasOwn(schema, key)) {
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
 * 收文字对象时挂上它（schema-i18n 的 withText，name 不变），出口按读者语言显示，message 是它的原文。
 */
export function configError(message: string | TextRef): Error {
  const error = new Error(typeof message === 'string' ? message : message.source);
  error.name = 'ConfigError';
  // 定义成自有属性而不是 delete：有的引擎把 stack 做成原型上的访问器，删实例属性去不掉
  Object.defineProperty(error, 'stack', { value: undefined, writable: true, configurable: true });
  return typeof message === 'string' ? error : withText(error, message);
}

/**
 * 缺少必填配置时的 {@link configError}：消息点名缺的字段（`note` 是放在字段名后括号里的补充说明），并说明
 * 填入后生效——WebUI 保存或配置文件热重载会重建实例、重试激活。
 */
export function missingConfigError(field: string, note?: string | TextRef): Error {
  return configError(note ? t('missingFieldNote', { field, note }) : t('missingField', { field }));
}

function validateFields(
  schema: Record<string, SchemaField | SchemaGroup | SchemaArray> | undefined,
  config: Record<string, unknown>,
  prefix: string,
  issues: SchemaIssue[],
): void {
  const push = (path: string, kind: SchemaIssue['kind'], { code, text }: Reason) =>
    issues.push({ path, message: text.source, kind, code, text });
  // `?? {}` 与 defaultsFrom 同款兜底：畸形 schema（array 缺 items / fields 为 null）
  // 不许把"最多少一条警告"升级成 TypeError——校验器自身永远不能成为故障源。
  for (const [key, entry] of Object.entries(schema ?? {})) {
    if (!entry || typeof entry !== 'object') continue;
    const path = prefix + key;
    const value = config[key];

    if ('fields' in entry) {
      if (value === undefined || value === null) continue;
      if (!isRecord(value)) {
        push(path, 'invalid', mismatch('expectedGroup', value));
        continue;
      }
      validateFields(entry.fields, value, `${path}.`, issues);
      continue;
    }

    if (entry.type === 'array') {
      if (value === undefined || value === null) continue;
      if (!Array.isArray(value)) {
        push(path, 'invalid', mismatch('expectedArray', value));
        continue;
      }
      value.forEach((item, i) => {
        if (!isRecord(item)) {
          push(`${path}[${i}]`, 'invalid', mismatch('expectedItem', item));
          return;
        }
        validateFields(entry.items, item, `${path}[${i}].`, issues);
      });
      continue;
    }

    if (isUnset(entry, value)) {
      // 声明了 default 的字段永远不算缺失：顶层/分组的默认值多已在调用点合并，但合并不覆盖
      // 显式 null（YAML 裸键），这类值照样走到这里，
      // 数组元素的默认值不参与任何合并（defaultsFrom 把 SchemaArray 当叶子），
      // 全靠这里放行——否则 required+default 的 item 字段会误报（scheduler jobs[].platform 型）。
      if (entry.required && !('default' in entry)) push(path, 'missing', { code: 'missing', text: t('missing') });
      continue;
    }
    if (entry.secret === true && isSecretRef(value)) continue;

    const verdict = judgeField(entry, value);
    if ('invalid' in verdict) {
      push(path, 'invalid', verdict.invalid);
      continue;
    }
    for (const d of verdict.dropped) push(path + d.at, 'invalid', d.reason);
    const invalid = verdict.dropped.length > 0 ? undefined : runValidate(entry, verdict.value);
    if (invalid) push(path, 'invalid', invalid);
  }
}

// ---- 逐字段判定：validateConfig 与 parseConfig 共用 ----

/** 值无效的原因：code 给程序判断（严格错误按它脱敏，见 safeInvalidReason），text 给人看 */
interface Reason {
  code: SchemaIssueCode;
  text: TextRef;
}

/** 类型或形状不符：字典里「期望…，得到 {got}」的几句 */
type Expected = Extract<keyof typeof t.source, `expected${string}`>;

function mismatch(expected: Expected, value: unknown): Reason {
  return { code: 'type', text: t(expected, { got: describeType(value) }) };
}

/**
 * 字段对一个已配置值（见 isUnset）的判定。`value` 是按词汇换算后的取值（数字转成的字符串、字符串转成的数字、
 * 归位后的选项值，外来类型是原值）；`dropped` 是 list / map / multiselect 里被剔除的元素，`at` 接在字段路径后。
 */
type FieldVerdict = { invalid: Reason } | { value: unknown; dropped: Array<{ at: string; reason: Reason }> };

/** 按类型与约束键判，外来类型不判；字段自己的 validate 由调用方处置完 dropped 之后调（runValidate） */
function judgeField(field: SchemaField, value: unknown): FieldVerdict {
  switch (field.type) {
    case 'string':
    case 'textarea': {
      const text = asText(value);
      if (text === undefined) return { invalid: mismatch('expectedString', value) };
      if (field.pattern !== undefined && !matchesPattern(field.pattern, text)) {
        return { invalid: { code: 'pattern', text: t('pattern', { pattern: field.pattern }) } };
      }
      if (field.format === undefined) return { value: text, dropped: [] };
      // 路径按去掉首尾空白后判定，交出去的也是这一份：带空白的原值交给插件会被当成相对路径或找不到
      const path = text.trim();
      if (path !== '' && !matchesFormat(field.format, path)) {
        return { invalid: { code: 'format', text: t(field.format === 'executable' ? 'executable' : 'absolutePath') } };
      }
      return { value: path, dropped: [] };
    }
    case 'number': {
      const num = asNumber(value);
      if (num === undefined) return { invalid: mismatch('expectedNumber', value) };
      if (field.integer && !Number.isInteger(num)) return { invalid: { code: 'integer', text: t('integer') } };
      if (field.min !== undefined && num < field.min) {
        return { invalid: { code: 'min', text: t('min', { min: field.min }) } };
      }
      if (field.max !== undefined && num > field.max) {
        return { invalid: { code: 'max', text: t('max', { max: field.max }) } };
      }
      return { value: num, dropped: [] };
    }
    case 'boolean':
      return typeof value === 'boolean' ? { value, dropped: [] } : { invalid: mismatch('expectedBoolean', value) };
    case 'select': {
      const text = asText(value);
      if (text === undefined) return { invalid: mismatch('expectedChoice', value) };
      const options = field.allowCustom === true ? undefined : choiceOptions(field);
      if (!options) return { value: text, dropped: [] };
      const hit = options.find(o => String(o.value) === text);
      return hit ? { value: hit.value, dropped: [] } : { invalid: notAnOption(options) };
    }
    case 'multiselect': {
      if (!Array.isArray(value)) return { invalid: mismatch('expectedArray', value) };
      const options = field.allowCustom === true ? undefined : choiceOptions(field);
      const kept: Array<string | number> = [];
      const dropped: Array<{ at: string; reason: Reason }> = [];
      const keep = (choice: string | number) => {
        if (field.ordered !== true || !kept.includes(choice)) kept.push(choice);
      };
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        const text = asText(item);
        if (text === undefined) {
          dropped.push({ at: `[${i}]`, reason: mismatch('expectedChoiceItem', item) });
        } else if (!options) {
          keep(text);
        } else {
          const hit = options.find(o => String(o.value) === text);
          if (hit) keep(hit.value);
          else dropped.push({ at: `[${i}]`, reason: notAnOption(options) });
        }
      }
      return { value: kept, dropped };
    }
    case 'list': {
      if (!Array.isArray(value)) return { invalid: mismatch('expectedArray', value) };
      const kept: string[] = [];
      const dropped: Array<{ at: string; reason: Reason }> = [];
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        const text = asText(item);
        if (text === undefined) dropped.push({ at: `[${i}]`, reason: mismatch('expectedStringItem', item) });
        else kept.push(text);
      }
      return { value: kept, dropped };
    }
    case 'map': {
      if (!isRecord(value)) return { invalid: mismatch('expectedMap', value) };
      const kept: Record<string, string> = {};
      const dropped: Array<{ at: string; reason: Reason }> = [];
      for (const [k, v] of Object.entries(value)) {
        const text = asText(v);
        if (text === undefined) dropped.push({ at: `.${k}`, reason: mismatch('expectedStringValue', v) });
        // 危险键不进结果对象：写 `__proto__` 会改掉结果的原型
        else if (isUnsafeConfigKey(k))
          dropped.push({ at: `.${k}`, reason: { code: 'reserved-key', text: t('reservedKey') } });
        else kept[k] = text;
      }
      return { value: kept, dropped };
    }
    default:
      return { value, dropped: [] };
  }
}

/**
 * 拿换算后的取值调字段自己的 validate：合法给 undefined。validate 抛错、或返回的不是非空字符串与文字对象时，原因写
 * 「校验时出错」（抛出的错里可能带着取值，不转述）
 */
function runValidate(field: SchemaField, value: unknown): Reason | undefined {
  if (field.validate === undefined) return undefined;
  let reason: unknown;
  try {
    reason = field.validate(value);
  } catch {
    return { code: 'validate', text: t('validateError') };
  }
  if (reason === undefined) return undefined;
  if (isTextRef(reason)) return { code: 'validate', text: reason };
  return {
    code: 'validate',
    text: typeof reason === 'string' && reason !== '' ? t('validateFailed', { reason }) : t('validateError'),
  };
}

/**
 * 填的是空串（WebUI 与脚手架用 `''` 表示未填）。声明了 format 的 string / textarea 交给插件的是去掉首尾空白的那份
 * （见 judgeField），只有空白同样算空串
 */
function isBlank(field: SchemaField, value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trims = field.format !== undefined && (field.type === 'string' || field.type === 'textarea');
  return (trims ? value.trim() : value) === '';
}

/** 没配置：undefined 与 null（YAML 裸键）；required 字段另把空串算进来（见 isBlank），外来类型的 `''` 一律算 */
function isUnset(field: SchemaField, value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return field.required ? isBlank(field, value) : value === '' && !NEUTRAL_FIELD_TYPES.has(field.type);
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

function notAnOption(options: Array<{ value: string | number }>): Reason {
  return { code: 'not-option', text: t('notOption', { options: options.map(o => JSON.stringify(o.value)) }) };
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

/** POSIX 绝对路径、Windows 盘符路径或 UNC 路径 */
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;

function matchesFormat(format: string, text: string): boolean {
  if (ABSOLUTE_PATH.test(text)) return true;
  if (format === 'executable') return !/[\\/]/.test(text) && !/^[A-Za-z]:/.test(text);
  // 不认识的写法（作者的 schema bug）同 pattern 一样跳过
  return format !== 'absolute-path';
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

/**
 * 顶层或分组内无法恢复的字段：parseConfig 把它转成 missingConfigError / configError 抛出，数组元素内只丢这一条元素；
 * `fatal` 的（没解析的密钥引用）在数组元素里也让整次解析失败
 */
class UnrecoverableField extends Error {
  constructor(
    readonly path: string,
    readonly reason: TextRef,
    readonly missing: boolean,
    readonly fatal = false,
  ) {
    super(`${path} ${reason.source}`);
  }
}

/**
 * 只在祖先值显式无效时检查；缺省的容器仍按字段原有的缺省规则解析。`top` 表示查的是整份配置：顶层带 session 的字段
 * parseConfig 不解析，不算
 */
function hasStrictField(schema: unknown, top = false): boolean {
  if (!isRecord(schema)) return false;
  return Object.values(schema).some(entry => {
    if (!isRecord(entry) || (top && isSessionField(entry))) return false;
    if (entry.onInvalid === 'error') return true;
    if ('fields' in entry) return hasStrictField(entry.fields);
    if (entry.type === 'array') return hasStrictField(entry.items);
    return false;
  });
}

function parseEntries(schema: unknown, source: Record<string, unknown>, prefix: string, warn: Warn) {
  // 畸形 schema（分组 fields 为 null、数组缺 items、条目为原始值）按空处理，不抛错
  const entries = isRecord(schema) ? schema : {};
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(entries)) {
    if (!isRecord(entry) || isUnsafeConfigKey(key)) continue;
    // 顶层（prefix 为空）带 session 的字段不交出：插件经会话设置的读取器读它。键仍在 schema 里，配置里有它也不告警
    if (prefix === '' && isSessionField(entry)) continue;
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
  else if (value !== undefined && value !== null) {
    if (hasStrictField(fields)) throw new UnrecoverableField(path, t('notGroup'), false);
    warn(`配置项 ${path} 期望对象（分组），得到 ${describeType(value)}，已忽略`);
  }
  return parseEntries(fields, source, `${path}.`, warn);
}

function parseField(field: SchemaField, value: unknown, path: string, warn: Warn): unknown {
  if (isUnset(field, value)) {
    if (field.default !== undefined) return cloneConfigValue(field.default);
    if (field.required) throw new UnrecoverableField(path, t('missing'), true);
    return undefined;
  }
  if (field.secret === true && isSecretRef(value)) {
    throw new UnrecoverableField(path, t('secretUnresolved', { key: value.$secret }), false, true);
  }
  const verdict = judgeField(field, value);
  if ('invalid' in verdict) return fallBack(field, path, verdict.invalid, warn);
  if (field.onInvalid === 'error' && verdict.dropped.length > 0) {
    const first = verdict.dropped[0];
    // map 键来自配置，可能本身是密钥；集合下标则可安全指出。
    const memberPath = field.type === 'map' ? path : path + first.at;
    throw new UnrecoverableField(memberPath, safeInvalidReason(first.reason), false);
  }
  for (const d of verdict.dropped) warn(`配置项 ${path}${d.at} ${d.reason.text.source}，已忽略`);
  const invalid = runValidate(field, verdict.value);
  if (invalid) return fallBack(field, path, invalid, warn);
  return cloneConfigValue(verdict.value);
}

function parseArray(entry: SchemaArray, value: unknown, path: string, warn: Warn): unknown[] | undefined {
  let list: unknown = value;
  if (value === undefined || value === null) {
    list = entry.default;
  } else if (!Array.isArray(value)) {
    if (hasStrictField(entry.items)) throw new UnrecoverableField(path, t('notArray'), false);
    list = fallBack(entry, path, mismatch('expectedArray', value), warn);
  }
  // 默认值同样逐元素解析：元素字段的默认值要补齐；default 本身不是数组（畸形 schema）按未配置处理
  if (!Array.isArray(list)) return undefined;
  const out: unknown[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const at = `${path}[${i}]`;
    if (!isRecord(item)) {
      if (entry.onInvalid === 'error') throw new UnrecoverableField(at, t('notItem'), false);
      warn(`配置项 ${at} 已忽略：期望对象元素，得到 ${describeType(item)}`);
      continue;
    }
    // 元素内的告警先攒着：这条元素整条丢弃时只报丢弃原因
    const pending: string[] = [];
    try {
      out.push(parseEntries(entry.items, item, `${at}.`, message => pending.push(message)));
    } catch (err) {
      if (!(err instanceof UnrecoverableField)) throw err;
      if (entry.onInvalid === 'error' || err.fatal) throw err;
      warn(`配置项 ${at} 已忽略：${err.path.slice(at.length + 1)} ${err.reason.source}`);
      continue;
    }
    for (const message of pending) warn(message);
  }
  return out;
}

/** 无效值的处置：有 default 回落并告警；无 default 且 required 不可恢复；否则省略并告警 */
function fallBack(
  entry: { default?: unknown; required?: boolean; onInvalid?: 'error' },
  path: string,
  reason: Reason,
  warn: Warn,
): unknown {
  if (entry.onInvalid === 'error') throw new UnrecoverableField(path, safeInvalidReason(reason), false);
  if (entry.default !== undefined) {
    warn(`配置项 ${path} ${reason.text.source}，改用默认值 ${describeDefault(entry.default)}`);
    return cloneConfigValue(entry.default);
  }
  if (entry.required) throw new UnrecoverableField(path, reason.text, false);
  warn(`配置项 ${path} ${reason.text.source}，已忽略`);
  return undefined;
}

/**
 * 严格错误的原因：可说明类型与约束，但不列出静态选项值与正则文本，按 code 换成不带它们的那句。类型不符只写类型名
 * （非有限数写成 NaN、Infinity，它们不会是密钥），本来就不带用户值
 */
function safeInvalidReason({ code, text }: Reason): TextRef {
  if (code === 'not-option') return t('notOptionHidden');
  if (code === 'pattern') return t('patternHidden');
  return text;
}

function describeDefault(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// 与 packages/core/src/infrastructure/config-values.ts 同一规则（本包不能 import core 的运行时）。
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

/** 原型就是 Array.prototype 的数组：子类的 map 会经 species 重新构造实例，按类实例透传 */
function isPlainConfigArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype;
}

/** 自有可枚举键逐个拷进新的纯对象，危险键跳过 */
function cloneEntries(obj: object, path: Set<object>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj)
      .filter(([key]) => !isUnsafeConfigKey(key))
      .map(([key, item]) => [key, cloneConfigValue(item, path)]),
  );
}

/**
 * 纯对象与普通数组逐层拷，同一条路径（path）上再遇到自己即环，抛错；共享而无环的引用照常拷成两份；类实例（含数组
 * 子类）按引用透传。抛错时整次拷贝作废，path 不必复原
 */
function cloneConfigValue(value: unknown, path: Set<object> = new Set()): unknown {
  const array = isPlainConfigArray(value);
  if (!array && !isPlainConfigObject(value)) return value;
  if (path.has(value)) throw new Error('The config contains a circular reference');
  path.add(value);
  const out = array ? value.map(item => cloneConfigValue(item, path)) : cloneEntries(value, path);
  path.delete(value);
  return out;
}

/** 总是新建纯对象：入参是类实例时取它的自有可枚举键；null、undefined 抛错 */
export function cloneConfigObject(obj: Record<string, unknown>): Record<string, unknown> {
  return cloneEntries(obj, new Set([obj]));
}

// PluginMeta.configSchema 由本包经 declaration merging 挂上。
// type-only import 仅作模块增强的解析锚点，编译后擦除——本包不依赖 core 的运行时。
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
