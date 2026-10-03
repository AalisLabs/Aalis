import type { SessionInfo } from '../../packages/api-session-manager/src/index.js';
import type { PageView, WebUIService } from '../../packages/api-webui/src/index.js';
import type { Logger } from '../../packages/core/src/index.js';
import { createPageRegistry, type Reply } from '../../packages/plugin-webui-server/src/pages.js';

// ════════════════════════════════════════════════════════════
// 页面插件的测试台：webui-server 的真实登记表（质量门槛、闸门、合并 invalidate）包成 WebUIService 交给插件，
// 不起端口。页面没过门槛时登记表记 error，用例读 logs 断言；invalidate 另记下每一次原样的调用，不受合并窗口影响。
// 数据源与动作经同一套闸门调用，调用者是 owner（webui:console）。
// ════════════════════════════════════════════════════════════

export interface PageHostOptions {
  /** 会话面板要核的会话；缺省没有会话 */
  sessions?: (sessionId: string) => SessionInfo | undefined;
  /** 文件单元格签发句柄；缺省一律签成 `signed:<地址>` */
  signFile?: (uri: string, name: string) => string | undefined;
}

export interface InvalidateCall {
  instance: string;
  pageKey: string;
  componentId?: string;
  sessionId?: string;
}

const CALLER = { platform: 'webui', userId: 'console' };

export function pageHost(opts: PageHostOptions = {}) {
  /** warn 与 error 级日志：页面没过门槛、数据源返回的形状不对、applies 出错 */
  const logs: string[] = [];
  const invalidations: InvalidateCall[] = [];
  const quiet = () => {};
  const logger: Logger = {
    debug: quiet,
    info: quiet,
    warn: (...args: unknown[]) => void logs.push(`warn ${args.map(String).join(' ')}`),
    error: (...args: unknown[]) => void logs.push(`error ${args.map(String).join(' ')}`),
    child: () => logger,
  };
  const registry = createPageRegistry({
    logger,
    send: quiet,
    sessions: () => ({ getSession: id => opts.sessions?.(id) }),
    signFile: opts.signFile ?? (uri => `signed:${uri}`),
  });
  const service: WebUIService = {
    getPort: () => 0,
    getHost: () => '127.0.0.1',
    addPage: registry.addPage,
    addNotice: registry.addNotice,
    invalidate(instance, pageKey, componentId, sessionId) {
      invalidations.push({
        instance,
        pageKey,
        ...(componentId === undefined ? {} : { componentId }),
        ...(sessionId === undefined ? {} : { sessionId }),
      });
      registry.invalidate(instance, pageKey, componentId, sessionId);
    },
  };

  /** 按页面 key 找到登记它的实例；没登记就报错 */
  function view(pageKey: string): PageView {
    const found = registry.views().find(page => page.key === pageKey);
    if (!found) throw new Error(`页面 ${pageKey} 没有登记；日志：${logs.join(' | ')}`);
    return found;
  }

  return {
    service,
    logs,
    invalidations,
    /** 登记着的页面（界面拿到的样子） */
    pages: () => registry.views(),
    view,
    /** 登记着的提示，带所属实例 */
    notices: () => registry.notices(),
    /** 取一个组件的数据：不是 200 就抛出，带状态码与原因 */
    async data<T = unknown>(pageKey: string, componentId: string, query: Record<string, unknown> = {}): Promise<T> {
      const reply = await registry.data(view(pageKey).instance, pageKey, componentId, query, CALLER);
      if (reply.status !== 200) throw new Error(`${reply.status} ${JSON.stringify(reply.body)}`);
      return (reply.body as { data: T }).data;
    },
    /** 调一个动作，原样回状态码与回包 */
    act: (pageKey: string, action: string, body: Record<string, unknown> = {}): Promise<Reply> =>
      registry.act(view(pageKey).instance, pageKey, action, body, CALLER, 'test'),
    /** 这个会话适用的会话面板页面的 key */
    async panels(sessionId: string): Promise<string[]> {
      const reply = await registry.panelPages(sessionId);
      if (reply.status !== 200) throw new Error(`${reply.status} ${JSON.stringify(reply.body)}`);
      return (reply.body as { pages: Array<{ pageKey: string }> }).pages.map(ref => ref.pageKey);
    },
    /** 清掉合并窗口的计时器 */
    dispose: () => registry.dispose(),
  };
}

export type PageHost = ReturnType<typeof pageHost>;
