// ============================================================
// pages.ts — 页面与提示的登记表，以及数据源与动作的服务端闸门
//
// 页面与提示按插件实例登记、按条目撤回，页面表变了推 plugins.changed，提示变了推 attention.changed（「需要处理」，见
// attention.ts）；invalidate 按实例、页面、组件与会话合并短时间内的连发；会话面板按会话一次算完
// 适用的页面。数据源与动作只许调页面声明过的，参数按声明核过再交给插件：会话面板的会话 id 是宿主单独设的字段，调用前
// 经会话管理核过会话存在；行动作只收 rowKey，插件按它重新查；输入按声明的字段校验类型、必填与可选项，拒收多余的键。
// 确认框只是界面上的交互，这里的闸门是 owner 身份（路由的 gate）加改状态请求的来源校验（auth.ts）。
// 路由（routes/pages.ts）只把请求交给这里、把结果写回。
//
// 插件前端页面登记时另从声明页面的模块往上找插件包根，核 webui/ 目录与入口文件，随机一个 token 记进登记条目：
// /frames/<token>/ 只托管这一次登记的 webui/（routes/frames.ts），页面撤回或重新登记后旧的 token 就找不到了。
// 它的数据源按名字分派，输入以 JSON 放在查询参数里，按声明的字段核；返回值要能转成 JSON。
// ============================================================

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UserIdentity } from '@aalis/api-authority';
import type { SessionManagerService } from '@aalis/api-session-manager';
import { isStorageUri } from '@aalis/api-storage';
import type {
  ActionInputFields,
  DeclarativePageView,
  ErrorResponse,
  FileCell,
  FrameDataResponse,
  FramePageView,
  Notice,
  PageActionResponse,
  PageContext,
  PageDataResponse,
  PageDefinition,
  PageRef,
  PageView,
  PanelPagesResponse,
  PanelSession,
  SessionPageContext,
  TableRow,
  WebuiAdminEvent,
} from '@aalis/api-webui';
import type { Logger } from '@aalis/core';
import { parseConfig, type SchemaIssue, validateConfig } from '@aalis/schema-config';
import {
  type CheckedFrame,
  type CheckedPage,
  type CheckedSource,
  checkNotice,
  checkPage,
  type SourceComponent,
} from './page-check.js';

/** invalidate 的合并窗口：同一实例、页面、组件与会话一秒内最多推一次，窗口里再来的并成窗口结束时的一次 */
export const INVALIDATE_WINDOW_MS = 1000;
/** 会话面板的 applies 最多等这么久，超时按不适用处理 */
export const APPLIES_TIMEOUT_MS = 2000;

interface PageRegistryDeps {
  logger: Logger;
  /** 推管理面事件 */
  send(event: WebuiAdminEvent): void;
  /** 会话管理：会话面板核会话存在、取会话种类 */
  sessions(): Pick<SessionManagerService, 'getSession'> | undefined;
  /** 文件单元格的存储地址换成下载句柄；不能签发时回 undefined */
  signFile(uri: string, name: string): string | undefined;
}

/** 回给路由的结果：状态码与回应，失败时回应是 ErrorResponse */
export interface Reply<T> {
  status: number;
  body: T | ErrorResponse;
}

/** 闸门拒了这次调用：状态码与给人看的原因 */
class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues?: SchemaIssue[],
  ) {
    super(message);
  }
}

interface PageEntry {
  instance: string;
  definition: PageDefinition;
  checked: CheckedPage;
  /** 插件前端页面的托管：webui/ 的 realpath、这次登记的 token，与界面拿到的框架地址和能力 */
  frame?: { dir: string; token: string; view: FramePageView['frame'] };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 页面的先后：order 小的在前，没写 order 的排在后面，再按实例与 key */
const rank = (order: number | undefined) => order ?? Number.MAX_SAFE_INTEGER;

/** 路径的 realpath；不存在或取不了（含带空字符的路径）回 undefined */
function realpathOf(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** relative 按 realpath 落在 dir（本身是 realpath）之内时回它的 realpath；不存在或越界（含指向外面的符号链接）回 undefined */
export function realWithin(dir: string, relative: string): string | undefined {
  const real = realpathOf(join(dir, relative));
  return real?.startsWith(dir + sep) ? real : undefined;
}

/** 从 from 往上找最近一个带 name 的 package.json（双格式构建里只写 type 的跳过），它的 name 要等于插件名 */
function packageRoot(from: string, plugin: string): { root: string } | { problem: string } {
  for (let dir = from; ; dir = dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      let name: unknown;
      try {
        name = JSON.parse(readFileSync(manifest, 'utf-8'))?.name;
      } catch {
        return { problem: `frame.module：${manifest} 读不出来` };
      }
      if (name !== undefined) {
        return name === plugin
          ? { root: dir }
          : { problem: `frame.module：包根 ${dir} 的 package.json 名为 ${String(name)}，不是插件名 ${plugin}` };
      }
    }
    if (dirname(dir) === dir) return { problem: `frame.module：从 ${from} 往上找不到带 name 的 package.json` };
  }
}

/** 插件前端的 webui/ 目录（realpath）：从声明页面的模块找到插件包根，核 webui/ 是目录、入口是它里面的文件 */
function frameDirOf(frame: CheckedFrame, instance: string): { dir: string } | { problem: string } {
  let from: string;
  try {
    from = dirname(fileURLToPath(frame.module));
  } catch {
    return { problem: 'frame.module：要是 file: 地址（写 import.meta.url）' };
  }
  // 插件名是实例 id 第一个「:」之前的部分
  const found = packageRoot(from, instance.split(':')[0]);
  if ('problem' in found) return found;
  const dir = realpathOf(join(found.root, 'webui'));
  if (!dir || !statSync(dir).isDirectory()) return { problem: `frame.module：包根 ${found.root} 下没有 webui/ 目录` };
  const entry = realWithin(dir, frame.entry);
  if (!entry || !statSync(entry).isFile()) {
    return { problem: `frame.entry：webui/${frame.entry} 不是 webui/ 里的文件` };
  }
  return { dir };
}

export function createPageRegistry(deps: PageRegistryDeps) {
  const { logger } = deps;
  const pages = new Map<string, PageEntry>();
  const notices = new Map<string, { instance: string; notice: Notice }>();
  const windows = new Map<string, { again: boolean; timer: ReturnType<typeof setTimeout> }>();
  const keyOf = (instance: string, key: string) => JSON.stringify([instance, key]);

  const sorted = () =>
    [...pages.values()].sort(
      (a, b) =>
        rank(a.definition.order) - rank(b.definition.order) ||
        a.instance.localeCompare(b.instance) ||
        a.definition.key.localeCompare(b.definition.key),
    );

  function entryOf(instance: string, pageKey: string): PageEntry {
    const entry = pages.get(keyOf(instance, pageKey));
    if (!entry) throw new Refusal(404, `页面 ${pageKey}（${instance}）不存在`);
    return entry;
  }

  /** 只许这些键，多余的列出来拒掉 */
  function onlyKeys(value: Record<string, unknown>, allowed: string[]): void {
    const extra = Object.keys(value).filter(key => !allowed.includes(key));
    if (extra.length > 0) throw new Refusal(400, `多余的参数：${extra.join('、')}`);
  }

  function requiredText(value: unknown, name: string): string {
    if (!isText(value)) throw new Refusal(400, `${name} 要是非空字符串`);
    return value;
  }

  /** 调用上下文：会话面板核过会话存在，给规范化后的会话 id */
  function contextOf(entry: PageEntry, sessionId: unknown, caller: UserIdentity): PageContext | SessionPageContext {
    if (entry.checked.placement !== 'session') return { caller };
    const session = sessionOf(requiredText(sessionId, 'sessionId'));
    return { caller, sessionId: session.id };
  }

  function sessionOf(sessionId: string) {
    const manager = deps.sessions();
    if (!manager) throw new Refusal(503, '会话管理服务不在，会话面板用不了');
    const session = manager.getSession(sessionId);
    if (!session) throw new Refusal(404, `会话 ${sessionId} 不存在`);
    return session;
  }

  /** 输入按声明的字段校验并解析：拒收多余的键，类型、必填与可选项不对的逐项列出 */
  function inputOf(fields: ActionInputFields, value: unknown): Record<string, unknown> {
    const input = value ?? {};
    if (!isRecord(input)) throw new Refusal(400, 'input 要是对象');
    const extra = Object.keys(input).filter(key => !Object.hasOwn(fields, key));
    if (extra.length > 0) throw new Refusal(400, `input 里多余的键：${extra.join('、')}`);
    const issues = validateConfig(fields, input);
    if (issues.length > 0) {
      throw new Refusal(400, `输入没过校验：${issues.map(i => `${i.path} ${i.message}`).join('；')}`, issues);
    }
    return parseConfig(fields, input);
  }

  /** 插件前端数据源的 input 查询参数：一个 JSON 字符串；没给时按空对象核 */
  function queryInput(value: unknown): unknown {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new Refusal(400, 'input 要是一个 JSON 字符串');
    try {
      return JSON.parse(value);
    } catch {
      throw new Refusal(400, 'input 不是合法的 JSON');
    }
  }

  /** 插件前端的数据源返回的值要能转成 JSON，不能的按形状不对处理 */
  function jsonData(entry: PageEntry, source: string, raw: unknown): unknown {
    let text: string | undefined;
    try {
      text = JSON.stringify(raw);
    } catch (err) {
      throw breach(entry, source, `不能转成 JSON：${errorText(err)}`);
    }
    if (text === undefined) throw breach(entry, source, '不能转成 JSON');
    return raw;
  }

  /** 插件的数据源返回的形状不对：记告警，这一块显示出错 */
  function breach(entry: PageEntry, componentId: string, problem: string): Refusal {
    const message = `数据源 ${componentId} 返回的数据不对：${problem}`;
    logger.warn(`页面 ${entry.definition.key}（${entry.instance}）的${message}`);
    return new Refusal(500, message);
  }

  /** 表格的行：核 rowKey 与 visibleWhen 指名的字段，图片列换成 /api/media 地址，文件列换成下载句柄 */
  function rowsOf(entry: PageEntry, table: Extract<SourceComponent, { type: 'table' }>, raw: unknown) {
    if (!Array.isArray(raw)) throw breach(entry, table.id, '要返回行的数组');
    const flags = (table.rowActions ?? []).flatMap(rowAction => rowAction.visibleWhen ?? []);
    const media = table.columns.filter(column => column.kind === 'image' || column.kind === 'file');
    const seen = new Set<string>();
    return raw.map((row: unknown, i) => {
      if (!isRecord(row)) throw breach(entry, table.id, `第 ${i + 1} 行不是对象`);
      const key = row[table.rowKey];
      if (!isText(key) || seen.has(key)) {
        throw breach(entry, table.id, `第 ${i + 1} 行的 ${table.rowKey} 要是不重复的非空字符串`);
      }
      seen.add(key);
      for (const flag of flags) {
        if (typeof row[flag] !== 'boolean') throw breach(entry, table.id, `第 ${i + 1} 行的 ${flag} 要是布尔值`);
      }
      const out: Record<string, unknown> = { ...(row as TableRow) };
      for (const column of media) {
        const uri = row[column.key];
        if (uri === undefined || uri === null || uri === '') continue;
        if (typeof uri !== 'string' || !isStorageUri(uri)) {
          throw breach(entry, table.id, `第 ${i + 1} 行的 ${column.key} 要是存储地址`);
        }
        if (column.kind === 'image') out[column.key] = `/api/media?${new URLSearchParams({ uri })}`;
        else {
          const name = uri.slice(uri.lastIndexOf('/') + 1);
          out[column.key] = { name, handle: deps.signFile(uri, name) } satisfies FileCell;
        }
      }
      return out;
    });
  }

  /** 按组件种类核数据源返回的形状 */
  function shaped(entry: PageEntry, source: CheckedSource, raw: unknown): unknown {
    const component = source.component;
    switch (component.type) {
      case 'table':
        return rowsOf(entry, component, raw);
      case 'markdown':
        if (typeof raw !== 'string') throw breach(entry, component.id, '要返回字符串');
        return raw;
      case 'info':
        if (!Array.isArray(raw) || !raw.every(item => isRecord(item) && typeof item.label === 'string')) {
          throw breach(entry, component.id, '要返回 { label, value } 的数组');
        }
        return raw;
      case 'graph': {
        if (!isRecord(raw) || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
          throw breach(entry, component.id, '要返回 { nodes, edges }');
        }
        const ids = new Set<string>();
        for (const node of raw.nodes) {
          if (!isRecord(node) || !isText(node.id) || ids.has(node.id) || typeof node.label !== 'string') {
            throw breach(entry, component.id, '节点要有不重复的 id 与 label');
          }
          ids.add(node.id);
        }
        for (const edge of raw.edges) {
          if (!isRecord(edge) || !ids.has(edge.source as string) || !ids.has(edge.target as string)) {
            throw breach(entry, component.id, '边的两端要是节点 id');
          }
        }
        return raw;
      }
    }
  }

  /** 跑一次调用：闸门拒的回它的状态码，插件抛的回 500 与原因 */
  async function guarded<T>(run: () => Promise<Reply<T>>): Promise<Reply<T>> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof Refusal) {
        return {
          status: err.status,
          body: err.issues ? { error: err.message, issues: err.issues } : { error: err.message },
        };
      }
      return { status: 500, body: { error: errorText(err) } };
    }
  }

  function invalidate(instance: string, pageKey: string, componentId?: string, sessionId?: string): void {
    const key = JSON.stringify([instance, pageKey, componentId ?? null, sessionId ?? null]);
    const open = windows.get(key);
    if (open) {
      open.again = true;
      return;
    }
    const event: WebuiAdminEvent = { type: 'page.invalidate', instance, pageKey, componentId, sessionId };
    deps.send(event);
    const slot = {
      again: false,
      timer: setTimeout(function close() {
        if (!slot.again) {
          windows.delete(key);
          return;
        }
        slot.again = false;
        deps.send(event);
        slot.timer = setTimeout(close, INVALIDATE_WINDOW_MS);
      }, INVALIDATE_WINDOW_MS),
    };
    windows.set(key, slot);
  }

  /** 会话面板的 applies：抛错、超时或没回布尔值都按不适用，记一条告警 */
  async function applies(entry: PageEntry, session: PanelSession): Promise<boolean> {
    const { definition } = entry;
    if (!definition.applies) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const verdict = await Promise.race([
        Promise.resolve().then(() => definition.applies?.(session)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`超过 ${APPLIES_TIMEOUT_MS} 毫秒没有答复`)), APPLIES_TIMEOUT_MS);
        }),
      ]);
      if (typeof verdict !== 'boolean') throw new Error('没有回布尔值');
      return verdict;
    } catch (err) {
      logger.warn(
        `会话面板页面 ${entry.definition.key}（${entry.instance}）的 applies 出错，按不适用处理: ${errorText(err)}`,
      );
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    addPage(definition: PageDefinition, instance: string): () => void {
      const refuse = (problems: string[]) => {
        logger.error(
          `页面 ${String((definition as { key?: unknown } | null)?.key)}（${instance}）没过登记校验，未登记：${problems.join('；')}`,
        );
        return () => {};
      };
      const result = checkPage(definition);
      if (!result.ok) return refuse(result.problems);
      const key = keyOf(instance, definition.key);
      const entry: PageEntry = { instance, definition, checked: result.page };
      if (result.page.kind === 'frame') {
        const { entry: path, host } = result.page.frame;
        const hosted = frameDirOf(result.page.frame, instance);
        if ('problem' in hosted) return refuse([hosted.problem]);
        const token = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');
        const src = `/frames/${token}/${path.split('/').map(encodeURIComponent).join('/')}`;
        entry.frame = { dir: hosted.dir, token, view: { src, host } };
      }
      pages.set(key, entry);
      deps.send({ type: 'plugins.changed' });
      // 插件重载时撤回与重新登记几乎同时，界面多半看不到页面不在的那一刻：打开着的这一页要换成新一次激活的数据
      invalidate(instance, definition.key);
      return () => {
        if (pages.get(key) !== entry) return;
        pages.delete(key);
        deps.send({ type: 'plugins.changed' });
      };
    },

    addNotice(notice: Notice, instance: string): () => void {
      const problems = checkNotice(notice, pageKey => pages.get(keyOf(instance, pageKey))?.checked.placement);
      if (problems.length > 0) {
        logger.error(
          `提示 ${String((notice as { id?: unknown } | null)?.id)}（${instance}）没过登记校验，未登记：${problems.join('；')}`,
        );
        return () => {};
      }
      const key = keyOf(instance, notice.id);
      const entry = { instance, notice };
      notices.set(key, entry);
      deps.send({ type: 'attention.changed' });
      return () => {
        if (notices.get(key) !== entry) return;
        notices.delete(key);
        deps.send({ type: 'attention.changed' });
      };
    },

    /** 登记着的提示，带所属实例 */
    notices: () => [...notices.values()].map(({ instance, notice }) => ({ instance, ...notice })),

    invalidate,

    /** 页面的位置；没登记的回 undefined */
    placementOf: (ref: PageRef) => pages.get(keyOf(ref.instance, ref.pageKey))?.checked.placement,

    /** GET /api/pages：声明式页面的声明经 JSON 下发时函数随之去掉；插件前端页面按字段组装，不带模块、入口与数据源 */
    views: (): PageView[] =>
      sorted().map(({ instance, definition, checked, frame }) =>
        frame
          ? {
              instance,
              key: definition.key,
              title: definition.title,
              icon: definition.icon,
              placement: checked.placement,
              order: definition.order,
              ...(checked.actions.size > 0 && { actions: Object.fromEntries(checked.actions) }),
              frame: frame.view,
            }
          : {
              ...(definition as Omit<DeclarativePageView, 'instance' | 'placement'>),
              instance,
              placement: checked.placement,
            },
      ),

    /** 插件前端的 webui/ 目录：token 是这一次登记的；页面撤回或重新登记后旧的找不到 */
    frameDir: (token: string): string | undefined =>
      [...pages.values()].find(entry => entry.frame?.token === token)?.frame?.dir,

    /** 这个会话适用的会话面板页面，按页面的先后 */
    panelPages: (sessionId: unknown): Promise<Reply<PanelPagesResponse>> =>
      guarded(async () => {
        const session = sessionOf(requiredText(sessionId, 'sessionId'));
        const target: PanelSession = { sessionId: session.id, kind: session.kind };
        const candidates = sorted().filter(entry => entry.checked.placement === 'session');
        const verdicts = await Promise.all(candidates.map(entry => applies(entry, target)));
        const refs: PageRef[] = candidates
          .filter((_, i) => verdicts[i])
          .map(entry => ({ instance: entry.instance, pageKey: entry.definition.key }));
        return { status: 200, body: { pages: refs } };
      }),

    /**
     * 取一个组件的数据；query 只收 sessionId（会话面板）与 rowKey（详情里的组件）。插件前端页面的 componentId 是数据源名，
     * query 只收 sessionId（会话面板）与 input（声明了输入的数据源）
     */
    data: (
      instance: string,
      pageKey: string,
      componentId: string,
      query: Record<string, unknown>,
      caller: UserIdentity,
    ): Promise<Reply<PageDataResponse | FrameDataResponse>> =>
      guarded(async () => {
        const entry = entryOf(instance, pageKey);
        const { checked } = entry;
        if (checked.kind === 'frame') {
          const source = checked.sources.get(componentId);
          if (!source) throw new Refusal(404, `页面 ${pageKey} 没有数据源 ${componentId}`);
          onlyKeys(query, [
            ...(checked.placement === 'session' ? ['sessionId'] : []),
            ...(source.input ? ['input'] : []),
          ]);
          const input = source.input ? inputOf(source.input, queryInput(query.input)) : undefined;
          const ctx = contextOf(entry, query.sessionId, caller);
          return { status: 200, body: { data: jsonData(entry, componentId, await source.data({ input, ctx })) } };
        }
        const source = checked.sources.get(componentId);
        if (!source) throw new Refusal(404, `页面 ${pageKey} 没有组件 ${componentId}`);
        onlyKeys(query, [
          ...(entry.checked.placement === 'session' ? ['sessionId'] : []),
          ...(source.inDetail ? ['rowKey'] : []),
        ]);
        const rowKey = source.inDetail ? requiredText(query.rowKey, 'rowKey') : undefined;
        const ctx = contextOf(entry, query.sessionId, caller);
        // 详情里的数据源另收 rowKey
        const args = rowKey === undefined ? { ctx } : { ctx, rowKey };
        const raw = await source.component.data(args);
        return { status: 200, body: { data: shaped(entry, source, raw) } };
      }),

    /** 调一个动作；body 只收 sessionId（会话面板）、rowKey（行动作）与 input（声明了输入的动作） */
    act: (
      instance: string,
      pageKey: string,
      name: string,
      body: unknown,
      caller: UserIdentity,
      from: string,
    ): Promise<Reply<PageActionResponse>> =>
      guarded(async () => {
        const entry = entryOf(instance, pageKey);
        const action = entry.checked.actions.get(name);
        if (!action) throw new Refusal(404, `页面 ${pageKey} 没有动作 ${name}`);
        if (!isRecord(body)) throw new Refusal(400, '请求体要是对象');
        onlyKeys(body, [
          ...(entry.checked.placement === 'session' ? ['sessionId'] : []),
          ...(action.row ? ['rowKey'] : []),
          ...(action.input ? ['input'] : []),
        ]);
        const rowKey = action.row ? requiredText(body.rowKey, 'rowKey') : undefined;
        const input = action.input ? inputOf(action.input, body.input) : undefined;
        const ctx = contextOf(entry, body.sessionId, caller);
        if (action.effect !== 'read') {
          logger.info(`页面动作 ${name}（${action.effect}）：${instance} 的页面 ${pageKey}，来自 ${from}`);
        }
        const result = await action.handler(rowKey === undefined ? { input, ctx } : { rowKey, input, ctx });
        if (result !== undefined && typeof result !== 'string') {
          logger.warn(`页面 ${pageKey}（${instance}）的动作 ${name} 返回的不是一句话，按失败处理`);
          throw new Refusal(500, `动作 ${name} 返回的不是一句话`);
        }
        return { status: 200, body: result === undefined ? {} : { message: result } };
      }),

    /** 停用时清掉合并窗口的计时器 */
    dispose(): void {
      for (const { timer } of windows.values()) clearTimeout(timer);
      windows.clear();
    },
  };
}

export type PageRegistry = ReturnType<typeof createPageRegistry>;
