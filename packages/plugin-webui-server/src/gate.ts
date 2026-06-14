import type { Context } from '@aalis/core';
import type { AuthorityService, CapabilityVisibility, UserIdentity } from '@aalis/plugin-authority-api';

/** 从请求解析调用者身份（auth.ts 的 AuthSystem.identify） */
type IdentifyFn = (req: { headers: { cookie?: string } }) => UserIdentity | undefined;

// 闸中间件只需要请求/响应的最小结构面。刻意不引 express 的泛型类型：
// RequestHandler<P> 会参与 express 5 路由参数 P 的联合推断，把 `:name` 等
// 参数widen 成 string | string[]；结构化参数对推断零干扰，且保持可单测。
interface GateRequest {
  headers: { cookie?: string };
}
interface GateResponse {
  status(code: number): { json(body: unknown): unknown };
}
type GateMiddleware = (req: GateRequest, res: GateResponse, next: () => void) => void;

/**
 * REST 路由能力闸工厂。
 *
 * 连接级认证（auth middleware）只回答"是否登录"；本闸回答"该身份能否做这件事"——
 * 每条 REST 路由声明一个 capability 与默认可见性，过 authorize 统一闸
 * （deny > owner(*) > public > granted）。owner 拥有一切；可对单账户 grant 某条
 * restricted capability（如 `webui:files:read`）做细粒度委托。
 *
 * 可见性约定（颗粒度由 capability 字符串本身承载，owner 之外的细分靠委托 grant）：
 * - 'public'：公共读（status / pages / 模型列表等，聊天面板可用即可）。
 * - 'restricted'：管理读（插件清单含原始配置、日志、文件浏览——可能含密钥）与
 *   一切变更操作（配置写、插件启停装卸、服务偏好、文件删改）；默认禁，须 owner /
 *   被委托授予。
 *
 * authority 服务缺席时：public 放行、restricted 503（fail-closed，不在权限服务缺位时裸奔）。
 */
export function createRouteGate(ctx: Context, identify: IdentifyFn) {
  return (capability: string, visibility: CapabilityVisibility): GateMiddleware =>
    (req, res, next) => {
      const authority = ctx.getService<AuthorityService>('authority');
      if (!authority) {
        // authority 缺席（未配置/启动失败/bounce 窗口期）→ 无法裁决。
        // 公共读放行，受限操作 503（区别于 403：服务暂不可用，非权限不足）。
        if (visibility === 'restricted') {
          res.status(503).json({ error: '权限服务不可用，受限操作暂时被拒绝' });
          return;
        }
        next();
        return;
      }
      const caller = identify(req) ?? { platform: 'webui', userId: 'console' };
      const denied = authority.authorize(caller, { capability, visibility });
      if (denied) {
        res.status(403).json({ error: denied });
        return;
      }
      next();
    };
}

/** createRouteGate 返回的闸生成函数类型（传给各 routes/ 注册器） */
export type RouteGate = ReturnType<typeof createRouteGate>;
