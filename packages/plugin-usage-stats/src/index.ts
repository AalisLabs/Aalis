// ════════════════════════════════════════════════════════════
// 用量统计：订阅 api-llm 的 llm:usage，每次模型调用在家目录的 state/usage/llm-calls.jsonl 里追加一行（时刻、服务商、模型、
// 调用方、会话、用途与三种 token），启动时读回、按天与模型合计。「用量统计」页按天、按周、按模型列出输入、缓存命中与输出；
// 配置里填了单价才有费用一列；有服务商的模型实现了余额查询（LLMModel.balance）才有「余额」一页，服务商上下线时随之增减
// ════════════════════════════════════════════════════════════

// biome-ignore lint/style/noRestrictedImports: 启动时按行流式读回账本，存储网关没有按行读
import { createReadStream } from 'node:fs';
// biome-ignore lint/style/noRestrictedImports: 账本是只追加的记录，存储网关没有追加写；位置取自 host-paths 给的家目录
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { hostPaths } from '@aalis/api-host-paths';
import { type LLMBalance, type LLMUsageEvent, llm } from '@aalis/api-llm';
import { type InfoItem, type TableColumn, type TableRow, webuiServer } from '@aalis/api-webui';
import {
  type BoundOf,
  config,
  definePlugin,
  events,
  lifecycle,
  logger,
  optional,
  type PluginManagerService,
  pluginsService,
} from '@aalis/core';
import { configError, defineConfig, parseConfig } from '@aalis/schema-config';

const configSchema = defineConfig({
  prices: {
    type: 'map',
    label: '单价',
    description:
      '每百万 token 的价格：键是模型 id，值依次写输入、缓存命中、输出三个价，用逗号隔开，如 deepseek-chat 写 2, 0.5, 8。' +
      '填了才有费用一列，没填单价的模型不算进费用',
    default: {},
  },
  currency: { type: 'string', label: '币种', description: '费用一列标的币种，只用于显示', default: 'CNY' },
});

const uses = {
  config,
  logger,
  lifecycle,
  events,
  /** 账本在家目录的 state 下 */
  paths: hostPaths,
  /** 「用量统计」页；不在时照样记账 */
  webui: optional(webuiServer),
  /** 余额：服务商的模型实现了余额查询才有 */
  llm: optional(llm),
  /** 服务商的显示名 */
  plugins: optional(pluginsService),
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-usage-stats',
  displayName: '用量统计',
  subsystem: 'llm',
  configSchema,
  uses,
  apply: run,
});

/** 账本的一行 */
interface LedgerLine extends LLMUsageEvent {
  at: number;
}

/** 一段时间里一个模型的合计；缓存命中只加服务商报了的，一次都没报时为 null */
interface Totals {
  input: number;
  cached: number | null;
  output: number;
}

interface Price {
  input: number;
  cached: number;
  output: number;
}

const PAGE_KEY = 'usage-stats';
/** 查余额的时限 */
const BALANCE_TIMEOUT_MS = 10_000;
const EMPTY = '还没有模型调用的记录';

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isText = (value: unknown) => value === undefined || typeof value === 'string';

function isLedgerLine(value: unknown): value is LedgerLine {
  if (typeof value !== 'object' || value === null) return false;
  const line = value as Record<string, unknown>;
  return (
    isCount(line.at) &&
    typeof line.provider === 'string' &&
    typeof line.model === 'string' &&
    isCount(line.inputTokens) &&
    isCount(line.outputTokens) &&
    (line.cachedTokens === undefined || isCount(line.cachedTokens)) &&
    isText(line.caller) &&
    isText(line.sessionId) &&
    isText(line.purpose)
  );
}

/** 配置里的单价：三个不小于 0 的数，写错时插件起不来 */
function parsePrices(prices: Record<string, string>): Map<string, Price> {
  const parsed = new Map<string, Price>();
  for (const [model, text] of Object.entries(prices)) {
    const values = text.split(',').map(part => Number(part.trim()));
    if (values.length !== 3 || !values.every(isCount)) {
      throw configError(
        `单价「${model}」要写成输入、缓存命中、输出三个价，用逗号隔开，在 WebUI 或配置文件中改正后生效`,
      );
    }
    const [input, cached, output] = values as [number, number, number];
    parsed.set(model, { input, cached, output });
  }
  return parsed;
}

const pad = (n: number) => String(n).padStart(2, '0');
const dateKey = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** 一周从周一起：这一天所在那周的周一与周日 */
function weekOf(day: string): { key: string; label: string } {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const monday = new Date(year, month - 1, date - ((new Date(year, month - 1, date).getDay() + 6) % 7));
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  const key = dateKey(monday);
  return { key, label: `${key} – ${pad(sunday.getMonth() + 1)}-${pad(sunday.getDate())}` };
}

function addTotals(into: Totals, from: Totals): void {
  into.input += from.input;
  into.output += from.output;
  if (from.cached !== null) into.cached = (into.cached ?? 0) + from.cached;
}

/** 插件实例的显示名：插件的显示名（没有时用包名），非默认实例另带实例名；插件已不在的用实例 id */
function instanceLabel(plugins: PluginManagerService | undefined, instance: string): string {
  const definition = plugins?.getPlugin(instance)?.definition;
  if (!definition) return instance;
  const name = definition.displayName ?? definition.name;
  return instance === definition.name ? name : `${name}（${instance.slice(definition.name.length + 1)}）`;
}

async function run(caps: Caps): Promise<void> {
  const { events, lifecycle, logger, webui } = caps;
  const cfg = parseConfig(configSchema, caps.config, logger);
  const prices = parsePrices(cfg.prices);
  /** 填了单价才有费用一列 */
  const priced = prices.size > 0;
  const file = join(caps.paths.require().state, 'usage', 'llm-calls.jsonl');

  /** 日期（本地时区）→ 模型（JSON 写的 [服务商, 模型]）→ 合计 */
  const days = new Map<string, Map<string, Totals>>();
  function add(line: LedgerLine): void {
    const day = dateKey(new Date(line.at));
    const models = days.get(day) ?? new Map<string, Totals>();
    days.set(day, models);
    const key = JSON.stringify([line.provider, line.model]);
    const totals = models.get(key) ?? { input: 0, cached: null, output: 0 };
    models.set(key, totals);
    addTotals(totals, { input: line.inputTokens, cached: line.cachedTokens ?? null, output: line.outputTokens });
  }

  // 按行流式读回：账本只增不减，整个读成一个字符串会随账本涨内存，超过字符串上限时就读不出来了
  let unreadable = 0;
  try {
    const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const raw of lines) {
      if (raw === '') continue;
      let line: unknown;
      try {
        line = JSON.parse(raw);
      } catch {
        line = undefined;
      }
      if (isLedgerLine(line)) add(line);
      else unreadable++;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`用量账本 ${file} 读不出来`, { cause: err });
    }
  }
  if (unreadable > 0) logger.warn(`用量账本 ${file} 有 ${unreadable} 行读不懂，已跳过`);
  await mkdir(dirname(file), { recursive: true });

  // 一行一行追加，后一行等前一行落定
  let writing = Promise.resolve();
  lifecycle.onDrain(() => writing, '用量账本落盘');

  const costOf = (model: string, totals: Totals): number | null => {
    const price = prices.get(model);
    if (!price) return null;
    const cached = totals.cached ?? 0;
    return ((totals.input - cached) * price.input + cached * price.cached + totals.output * price.output) / 1_000_000;
  };
  /** 一组（服务商, 模型）合计并成一行：费用只算填了单价的模型，一个都没有时为 null */
  function row(models: Iterable<[string, Totals]>): TableRow {
    const sum: Totals = { input: 0, cached: null, output: 0 };
    let cost: number | null = null;
    for (const [key, totals] of models) {
      addTotals(sum, totals);
      const modelCost = costOf((JSON.parse(key) as [string, string])[1], totals);
      if (modelCost !== null) cost = (cost ?? 0) + modelCost;
    }
    return {
      ...sum,
      ...(priced ? { cost: cost === null ? null : Math.round(cost * 100) / 100 } : {}),
    };
  }
  /** 按键（日期写法）从新到旧 */
  const newestFirst = <T>(entries: Iterable<[string, T]>) =>
    [...entries].sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0));

  const dayRows = (): TableRow[] => newestFirst(days).map(([day, models]) => ({ day, ...row(models) }));

  function weekRows(): TableRow[] {
    const weeks = new Map<string, { label: string; models: Array<[string, Totals]> }>();
    for (const [day, models] of days) {
      const { key, label } = weekOf(day);
      const week = weeks.get(key) ?? { label, models: [] };
      weeks.set(key, week);
      week.models.push(...models);
    }
    return newestFirst(weeks).map(([, { label, models }]) => ({ week: label, ...row(models) }));
  }

  function modelRows(): TableRow[] {
    const byModel = new Map<string, Totals>();
    for (const models of days.values()) {
      for (const [key, totals] of models) {
        const sum = byModel.get(key) ?? { input: 0, cached: null, output: 0 };
        byModel.set(key, sum);
        addTotals(sum, totals);
      }
    }
    return [...byModel]
      .sort(([, a], [, b]) => b.input + b.output - (a.input + a.output))
      .map(([key, totals]) => {
        const [provider, model] = JSON.parse(key) as [string, string];
        return { key, model, provider: instanceLabel(caps.plugins.current, provider), ...row([[key, totals]]) };
      });
  }

  /** 实现了余额查询的服务商各查一次：一个币种一项，查不到的写明原因 */
  async function balances(): Promise<InfoItem[]> {
    const providers = new Map<string, (signal: AbortSignal) => Promise<LLMBalance[]>>();
    for (const { instance } of caps.llm.all()) {
      const { balance } = instance;
      if (balance && !providers.has(instance.providerId)) {
        providers.set(instance.providerId, signal => balance.call(instance, signal));
      }
    }
    const items = await Promise.all(
      [...providers].map(async ([provider, balance]): Promise<InfoItem[]> => {
        const label = instanceLabel(caps.plugins.current, provider);
        try {
          const list = await balance(AbortSignal.timeout(BALANCE_TIMEOUT_MS));
          return list.map(({ currency, amount }) => ({ label: `${label}（${currency}）`, value: amount }));
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return [{ label, value: { text: `查不到：${reason}`, state: 'error' }, kind: 'status' }];
        }
      }),
    );
    return items.flat();
  }

  const description = priced ? '费用按配置里的单价估算，没填单价的模型不算在内' : undefined;
  // 窄时留首列与输入，另一列有费用时是费用、没有时是输出
  const columns = (first: TableColumn[]): TableColumn[] => [
    ...first,
    { key: 'input', label: '输入', primary: true },
    { key: 'cached', label: '缓存命中' },
    { key: 'output', label: '输出', primary: !priced },
    ...(priced ? [{ key: 'cost', label: `费用（${cfg.currency}）`, primary: true }] : []),
  ];

  const definePage = (withBalance: boolean) =>
    webui.definePage({
      key: PAGE_KEY,
      title: '用量统计',
      icon: 'chart-column',
      content: {
        tabs: [
          {
            key: 'days',
            title: '按天',
            content: [
              {
                type: 'table',
                id: 'days',
                rowKey: 'day',
                description,
                empty: EMPTY,
                columns: columns([{ key: 'day', label: '日期', primary: true }]),
                data: dayRows,
              },
            ],
          },
          {
            key: 'weeks',
            title: '按周',
            content: [
              {
                type: 'table',
                id: 'weeks',
                rowKey: 'week',
                description,
                empty: EMPTY,
                columns: columns([{ key: 'week', label: '周', primary: true }]),
                data: weekRows,
              },
            ],
          },
          {
            key: 'models',
            title: '按模型',
            content: [
              {
                type: 'table',
                id: 'models',
                rowKey: 'key',
                description,
                empty: EMPTY,
                columns: columns([
                  { key: 'model', label: '模型', primary: true },
                  { key: 'provider', label: '服务商' },
                ]),
                data: modelRows,
              },
            ],
          },
          ...(withBalance
            ? [{ key: 'balance', title: '余额', content: [{ type: 'info' as const, id: 'balance', data: balances }] }]
            : []),
        ],
      },
    });

  // 有没有服务商实现了余额查询，llm 的提供者增减时重看：变了就重新登记这一页（同一个 key 是替换）
  const anyBalance = () => caps.llm.all().some(({ instance }) => instance.balance !== undefined);
  let hasBalance = anyBalance();
  let page = definePage(hasBalance);
  const recheck = (name: string) => {
    if (name !== llm.name || anyBalance() === hasBalance) return;
    hasBalance = !hasBalance;
    page = definePage(hasBalance);
  };
  events.on('service:registered', recheck);
  events.on('service:unregistered', recheck);

  events.on('llm:usage', usage => {
    const line: LedgerLine = { at: Date.now(), ...usage };
    add(line);
    writing = writing
      .then(() => appendFile(file, `${JSON.stringify(line)}\n`))
      .catch(err => logger.warn(`用量账本追加失败 (${file}):`, err));
    // 只作废三张表：「余额」不跟着每次调用重查
    for (const component of ['days', 'weeks', 'models']) page.invalidate(component);
  });
}
