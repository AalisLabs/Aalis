import type { Context } from '@aalis/core';
import type { AuthorityService, UserIdentity } from '@aalis/plugin-authority-api';

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
 * REST 路由权限闸工厂。
 *
 * 连接级认证（auth middleware）只回答"是否登录"；本闸回答"该身份能否做这件事"——
 * 每条 REST 路由声明一个 capability 与基础等级门槛，过 authorize 统一闸
 * （与 tool/command/page-action 同一裁决：permissionPolicy > deny > grant > 角色链，
 * 因此可对单个账户 grant `webui:files:read` 这类细粒度放行）。
 *
 * 分层缺省（可经 config.permissionAuthority 或 per-user grant/deny 调整）：
 * - 1：公共读（status / pages / 模型列表等，聊天面板可用即可）
 * - 4：管理读（插件清单含原始配置、日志、文件浏览——可能含密钥/敏感信息）
 * - 'owner'：变更操作（配置写、插件启停装卸、服务偏好、文件删改）
 *
 * authority 服务缺席时放行（与 tools/commands 守卫缺席语义一致）。
 */
export function createRouteGate(ctx: Context, identify: IdentifyFn) {
  // 公共读基线：authority 缺席时，门槛 <= 此值的路由仍放行（聊天面板可用即可），
  // 高于此值的（管理读/变更）一律拒绝——fail-closed，不在权限服务缺位时裸奔。
  const PUBLIC_BASELINE = 1;
  return (capability: string, declared: number | 'owner'): GateMiddleware =>
    (req, res, next) => {
      const ownerLevel = ctx.config.get('ownerAuthority') ?? 5;
      const declaredAuthority = declared === 'owner' ? ownerLevel : declared;
      const authority = ctx.getService<AuthorityService>('authority');
      if (!authority) {
        // authority 缺席（未配置/启动失败/bounce 窗口期）→ 无法裁决等级。
        // 公共读放行，其余 503（区别于 403：服务暂不可用，非权限不足）。
        if (declaredAuthority > PUBLIC_BASELINE) {
          res.status(503).json({ error: '权限服务不可用，敏感操作暂时被拒绝' });
          return;
        }
        next();
        return;
      }
      const caller = identify(req) ?? { platform: 'webui', userId: 'console' };
      const denied = authority.authorize(caller, { capabilities: [capability], declaredAuthority });
      if (denied) {
        res.status(403).json({ error: denied });
        return;
      }
      next();
    };
}

/** createRouteGate 返回的闸生成函数类型（传给各 routes/ 注册器） */
export type RouteGate = ReturnType<typeof createRouteGate>;
