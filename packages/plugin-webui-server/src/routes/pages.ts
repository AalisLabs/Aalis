// ============================================================
// routes/pages.ts — 声明式页面、会话面板与布局记录的 REST 路由
//
// 路径与返回形状见 api-webui 的 page.ts。页面的数据源与动作要把调用者与读者的语言链交给插件，这两条路由自己解析身份
// （与 gate 同一判定）；其余用 gate。闸门与校验在 pages.ts，这里只把请求交过去、把结果连同它要的渲染选项写回。布局记录
// 存在插件数据里，存储服务不在时回 503。
// ============================================================

import type { IncomingMessage } from 'node:http';
import type { UserIdentity } from '@aalis/api-authority';
import type { ErrorResponse, WebuiAdminEvent } from '@aalis/api-webui';
import type { Logger } from '@aalis/core';
import type express from 'express';
import type { RouteGate } from '../gate.js';
import { LayoutFull, type LayoutStore, parseLayoutOperation } from '../layout.js';
import { renderWith, skipSchemaDefaults } from '../localize.js';
import type { PageRegistry, Reply } from '../pages.js';
import { route } from '../route.js';
import { t } from '../texts.js';

export function registerPageRoutes(
  expressApp: express.Express,
  deps: {
    registry: PageRegistry;
    layout: LayoutStore;
    /** 存储服务在不在：布局记录读写要它 */
    storageReady(): boolean;
    send(event: WebuiAdminEvent): void;
    /** 读者的语言链（localize.ts） */
    languages(req: IncomingMessage): readonly string[];
    logger: Logger;
  },
  identify: (req: { headers: { cookie?: string } }) => UserIdentity | undefined,
  gate: RouteGate,
): void {
  const { registry, layout } = deps;
  const reply = <T>(res: express.Response<T | ErrorResponse>, { status, body, render }: Reply<T>) => {
    if (render) renderWith(res, render);
    res.status(status).json(body);
  };
  const forbidden = (res: express.Response<ErrorResponse>) => res.status(403).json({ error: t('ownerRequired') });

  route(expressApp, 'GET /api/pages', gate(), (_req, res) => {
    const pages = registry.views();
    const inputs = pages.flatMap(page => Object.values(page.actions ?? {}).map(action => action.input));
    renderWith(res, { skip: skipSchemaDefaults(inputs) });
    res.json({ pages });
  });

  route(expressApp, 'GET /api/session-pages', gate(), async (req, res) => {
    reply(res, await registry.panelPages(req.query.sessionId));
  });

  route(expressApp, 'GET /api/pages/:instance/:pageKey/data/:componentId', async (req, res) => {
    const caller = identify(req);
    if (!caller) return forbidden(res);
    const { instance, pageKey, componentId } = req.params;
    const ctx = { caller, languages: deps.languages(req) };
    reply(res, await registry.data(instance, pageKey, componentId, req.query, ctx));
  });

  route(expressApp, 'POST /api/pages/:instance/:pageKey/actions/:action', async (req, res) => {
    const caller = identify(req);
    if (!caller) return forbidden(res);
    const { instance, pageKey, action } = req.params;
    const ctx = { caller, languages: deps.languages(req) };
    reply(res, await registry.act(instance, pageKey, action, req.body, ctx, req.socket.remoteAddress ?? '未知'));
  });

  const storageMissing = (res: express.Response<ErrorResponse>) =>
    res.status(503).json({ error: t('noStorageLayout') });

  route(expressApp, 'GET /api/layout', gate(), async (_req, res) => {
    if (!deps.storageReady()) return storageMissing(res);
    try {
      res.json(await layout.read());
    } catch (err) {
      deps.logger.warn('读取布局记录失败:', err);
      res.status(500).json({ error: t('layoutReadFailed') });
    }
  });

  route(expressApp, 'POST /api/layout', gate(), async (req, res) => {
    if (!deps.storageReady()) return storageMissing(res);
    const operation = parseLayoutOperation(req.body);
    if (!operation) {
      return res.status(400).json({ error: t('layoutOpInvalid') });
    }
    // 固定与打开插件标签只收此刻登记着、位置对的页面；其余只动记录，所属插件停用时也能改
    const wanted =
      operation.op === 'pin'
        ? { page: operation.page, placement: 'plugin', refusal: t('pinPluginOnly') }
        : operation.op === 'open-tab' && !('host' in operation.tab)
          ? { page: operation.tab, placement: 'session', refusal: t('openSessionOnly') }
          : undefined;
    if (wanted) {
      const placement = registry.placementOf(wanted.page);
      if (!placement) {
        return res
          .status(404)
          .json({ error: t('pageMissing', { page: wanted.page.pageKey, instance: wanted.page.instance }) });
      }
      if (placement !== wanted.placement) return res.status(400).json({ error: wanted.refusal });
    }
    try {
      const { records, changed } = await layout.apply(operation);
      if (changed) deps.send({ type: 'layout.changed' });
      res.json(records);
    } catch (err) {
      if (err instanceof LayoutFull) {
        res.status(409).json({ error: err.text });
        return;
      }
      deps.logger.warn('保存布局记录失败:', err);
      res.status(500).json({ error: t('layoutSaveFailed') });
    }
  });
}
