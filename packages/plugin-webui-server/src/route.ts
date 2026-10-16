// ============================================================
// route.ts — 按契约登记路由
//
// 路由一律经这里登记，键是 api-webui 管理面 REST 路由表（rest.ts）里的键，方法与路径从键里拆出来交给 express。回 JSON 的
// 路由，处理函数只能回契约里的回应或 ErrorResponse（服务端交出的形状，文字可以是文字对象，发出前由 localize.ts 渲染），
// 编译期就核；回文件的不限。都经这里登记由 test/architecture/webui-routes.test.ts 守住，实际登记的与路由表逐条对上由
// test/plugins/webui-rest-contract.test.ts 守住
// ============================================================

import type { ErrorResponse, WebuiFileRoutes, WebuiRestRoutes } from '@aalis/api-webui';
import type { SchemaIssue } from '@aalis/schema-config';
import type express from 'express';

type RouteKey = keyof WebuiRestRoutes | keyof WebuiFileRoutes;

/** 处理函数能回的：JSON 路由是契约里的回应或失败，文件路由不限 */
type Reply<K extends RouteKey> = K extends keyof WebuiRestRoutes
  ? WebuiRestRoutes[K]['response'] | ErrorResponse
  : unknown;

/** 路径里的 `:name` 参数，各是一段 */
type Params<S extends string> = S extends `${string}:${infer Name}/${infer Rest}`
  ? Record<Name, string> & Params<Rest>
  : S extends `${string}:${infer Name}`
    ? Record<Name, string>
    : Record<never, never>;

type RouteHandler<K extends RouteKey> = (
  req: express.Request<Params<K>>,
  res: express.Response<Reply<K>>,
  next: express.NextFunction,
) => unknown;

/** 校验问题交到 ErrorResponse 里的样子：说明只在 message 一处，取这一项的文字对象，由出口按读者渲染 */
export const issueViews = (issues: readonly SchemaIssue[]): NonNullable<ErrorResponse['issues']> =>
  issues.map(({ path, kind, code, text }) => ({ path, kind, code, message: text }));

export function route<K extends RouteKey>(app: express.Express, key: K, ...handlers: RouteHandler<K>[]): void {
  const space = key.indexOf(' ');
  const method = key.slice(0, space).toLowerCase() as 'get' | 'post' | 'put' | 'delete';
  app[method](key.slice(space + 1), ...(handlers as express.RequestHandler[]));
}
