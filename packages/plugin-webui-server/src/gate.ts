import type { UserIdentity } from '@aalis/plugin-authority-api';

/** 从请求解析调用者身份（auth.ts 的 AuthSystem.identify） */
type IdentifyFn = (req: { headers: { cookie?: string } }) => UserIdentity | undefined;

// 闸中间件只需要请求/响应的最小结构面。刻意不引 express 的泛型类型：
// RequestHandler<P> 会参与 express 5 路由参数 P 的联合推断，把 `:name` 等
// 参数 widen 成 string | string[]；结构化参数对推断零干扰，且保持可单测。
interface GateRequest {
  headers: { cookie?: string };
}
interface GateResponse {
  status(code: number): { json(body: unknown): unknown };
}
type GateMiddleware = (req: GateRequest, res: GateResponse, next: () => void) => void;

/**
 * REST 路由 owner 闸工厂（单 owner 终态）。
 *
 * 单 token 模式下「持 token ⟺ webui:console ⟺ owner」，故连接级认证（auth.middleware
 * 校验 token，未认证一律 401）即等价于 owner 鉴权。本闸是 REST 层的显式 owner 复核
 * （防御纵深，与 auth.middleware 同义）：身份解析得到即放行，否则 403。
 *
 * 多账户 / 能力委托已剥离，故不再有 per-route capability 与档位裁决——所有需登录的
 * REST 路由统一是 owner-only。页面/状态等只读路由同样在 auth.middleware 之后，对
 * 单 owner 无区别。
 */
export function createRouteGate(identify: IdentifyFn) {
  return (): GateMiddleware => (req, res, next) => {
    if (!identify(req)) {
      res.status(403).json({ error: '需要 owner 权限' });
      return;
    }
    next();
  };
}

/** createRouteGate 返回的闸生成函数类型（传给各 routes/ 注册器） */
export type RouteGate = ReturnType<typeof createRouteGate>;
