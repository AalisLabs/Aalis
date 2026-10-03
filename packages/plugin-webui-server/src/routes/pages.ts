// ============================================================
// routes/pages.ts — 声明式页面、会话面板与布局记录的 REST 路由
//
// 路径与返回形状见 api-webui 的 page.ts。页面的数据源与动作要把调用者交给插件，这两条路由自己解析身份（与 gate 同一判定）；
// 其余用 gate。闸门与校验在 pages.ts，这里只把请求交过去、把结果写回。布局记录存在插件数据里，存储服务不在时回 503。
// ============================================================

import type { UserIdentity } from '@aalis/api-authority';
import type { WebuiAdminEvent } from '@aalis/api-webui';
import type { Logger } from '@aalis/core';
import type express from 'express';
import type { RouteGate } from '../gate.js';
import { LayoutFull, type LayoutStore, parseLayoutOperation } from '../layout.js';
import type { PageRegistry, Reply } from '../pages.js';

export function registerPageRoutes(
  expressApp: express.Express,
  deps: {
    registry: PageRegistry;
    layout: LayoutStore;
    /** 存储服务在不在：布局记录读写要它 */
    storageReady(): boolean;
    send(event: WebuiAdminEvent): void;
    logger: Logger;
  },
  identify: (req: { headers: { cookie?: string } }) => UserIdentity | undefined,
  gate: RouteGate,
): void {
  const { registry, layout } = deps;
  const reply = (res: express.Response, { status, body }: Reply) => res.status(status).json(body);
  const forbidden = (res: express.Response) => res.status(403).json({ error: '需要 owner 权限' });

  expressApp.get('/api/pages', gate(), (_req, res) => {
    res.json({ pages: registry.views() });
  });

  expressApp.get('/api/session-pages', gate(), async (req, res) => {
    reply(res, await registry.panelPages(req.query.sessionId));
  });

  expressApp.get('/api/pages/:instance/:pageKey/data/:componentId', async (req, res) => {
    const caller = identify(req);
    if (!caller) return forbidden(res);
    const { instance, pageKey, componentId } = req.params;
    reply(res, await registry.data(instance, pageKey, componentId, req.query, caller));
  });

  expressApp.post('/api/pages/:instance/:pageKey/actions/:action', async (req, res) => {
    const caller = identify(req);
    if (!caller) return forbidden(res);
    const { instance, pageKey, action } = req.params;
    reply(res, await registry.act(instance, pageKey, action, req.body, caller, req.socket.remoteAddress ?? '未知'));
  });

  const storageMissing = (res: express.Response) => res.status(503).json({ error: '存储服务不在，布局记录读写不了' });

  expressApp.get('/api/layout', gate(), async (_req, res) => {
    if (!deps.storageReady()) return storageMissing(res);
    try {
      res.json(await layout.read());
    } catch (err) {
      deps.logger.warn('读取布局记录失败:', err);
      res.status(500).json({ error: '读取布局记录失败' });
    }
  });

  expressApp.post('/api/layout', gate(), async (req, res) => {
    if (!deps.storageReady()) return storageMissing(res);
    const operation = parseLayoutOperation(req.body);
    if (!operation) {
      return res.status(400).json({
        error:
          '操作要是 { op, page } 或 { op, tab }：pin、unpin、move-up、move-down 带 page（{ instance, pageKey }），' +
          'open-tab、close-tab、tab-up、tab-down 带 tab（{ host } 或 { instance, pageKey }），' +
          'remove-tab 只带插件标签 tab（{ instance, pageKey }），宿主标签只能关闭、不能移出',
      });
    }
    // 固定与打开插件标签只收此刻登记着、位置对的页面；其余只动记录，所属插件停用时也能改
    const wanted =
      operation.op === 'pin'
        ? { page: operation.page, placement: 'plugin', refusal: '只有位置为插件详情的页面能固定' }
        : operation.op === 'open-tab' && !('host' in operation.tab)
          ? { page: operation.tab, placement: 'session', refusal: '只有会话面板的页面能在面板里打开' }
          : undefined;
    if (wanted) {
      const placement = registry.placementOf(wanted.page);
      if (!placement) {
        return res.status(404).json({ error: `页面 ${wanted.page.pageKey}（${wanted.page.instance}）不存在` });
      }
      if (placement !== wanted.placement) return res.status(400).json({ error: wanted.refusal });
    }
    try {
      const { records, changed } = await layout.apply(operation);
      if (changed) deps.send({ type: 'layout.changed' });
      res.json(records);
    } catch (err) {
      if (err instanceof LayoutFull) {
        res.status(409).json({ error: err.message });
        return;
      }
      deps.logger.warn('保存布局记录失败:', err);
      res.status(500).json({ error: '保存布局记录失败，记录没有改动' });
    }
  });
}
