# 权限系统 — capability 统一闸

管理调用者身份、capability 裁决、账户登录与高危操作确认。

**源码**: `packages/plugin-authority/src/index.ts`（实现）/ `packages/plugin-authority-api/src/index.ts`（契约）

> 2026-06 模型定型：**capability 图是唯一裁决机制**，数字等级只是内置角色链的命名
> （level-1 ⊂ level-2 ⊂ … ⊂ owner，每级继承下级全部授予）。插件声明的
> `authority: number` 照常书写，语义为"该操作的 capability 归入 level-N 角色包"。

## capability 词汇

capability 即细粒度权限标识（`PermissionId`），现有词汇族：

| 形状 | 产出者 | 示例 |
|---|---|---|
| `tool:<name>` | 工具注册自动生成 + 声明 | `tool:file.write` |
| `command:<name>` | 指令注册自动生成 | `command:shutdown` |
| `action:<plugin>:<method>` | WebUI page-action 路由 | `action:@aalis/plugin-skills:reload` |
| `webui:<area>:<op>` | WebUI REST 路由闸（gate.ts） | `webui:config:write` |
| `storage:<op>` / `storage:path:<uri>:<op>` | file 工具参数解析（动态） | `storage:path:data:/users.json:write` |
| `system:*` / `runtime:*` | tool-system / code-runner 声明 | `system:process.exec` |

## 裁决：authorize 统一闸

任何 surface（tool / command / WebUI action / REST / scheduler）的敏感操作在边界统一调用：

```typescript
authority.authorize(identity, { capabilities, declaredAuthority })  // → null 放行 | string 拒绝原因
```

**优先级（per-capability）**：

1. 全局 `permissionPolicy`（系统级 allow/deny）
2. 用户 **deny**（命中即拒绝，对 owner 同样生效——慎用）
3. 用户 **grant**（命中则该 capability 无视等级放行，不影响同操作的其他 capability）
4. 角色链等级门槛：用户等级 ≥ `max(declaredAuthority, requiredAuthorityFor([cap]))`

`requiredAuthorityFor`（参数级动态提权）内置敏感清单（写/删 `data:/users.json`、
`data:/scheduler-jobs.json`、`aalis:/` 源码根 → owner 级），可经
`config.permissionAuthority`（glob → 等级）覆盖/扩展，只升不降。

`ExecutionGuard` 仍是 tools/commands surface 的适配器：等级/策略/授予裁决全部委托
authorize，dangerous 确认（交互流程）留在适配器层。

## 身份与等级

```
getAuthority(platform, userId) 判定顺序：
1. userId 缺失 → defaultAuthority
2. webui:console / cli:console → ownerAuthority（单 token 单人模式）
3. 配置 owners 列表命中 → ownerAuthority
4. users.json 记录 level → 该值
5. 兜底 defaultAuthority（默认 1）
```

| 等级 | 角色 | 说明 |
|---|---|---|
| 0 | 匿名 | 无指令权限 |
| 1 | 普通用户 | 默认等级（`defaultAuthority`） |
| 2-4 | 管理员档 | /grant 管理、WebUI 管理读（4）等 |
| 5 | Owner | 变更类操作与 dangerous 白名单管理 |

## 账户与 WebUI 登录

账户 = 带密码凭据的用户记录（`setPassword` / `verifyPassword` / `hasPassword`，
Web Crypto PBKDF2-SHA256，凭据存 users.json、永不经 API 返回）。

WebUI 双模式登录（`plugin-webui-server/src/auth.ts`）：

- **账户登录**：username/password → 内存 session + HttpOnly cookie，身份 `webui:<username>`；
  连续失败 5 次锁定 60s
- **单 token 模式**（向后兼容）：访问 token → 身份 `webui:console`（owner 级单人语义——
  token 存于服务器磁盘/启动日志，持有 token ≈ 控制服务器 ≈ owner，信任映射诚实）
- **多用户收口**：`tokenMode: disabled` 时，只要存在任一带密码的 webui 账户，token
  登录全面失效（cookie / `?token=` / 登录表单均拒）；无账户时 token 仍兜底生效（防锁死）

REST 路由经 `gate.ts` 按 capability 过 authorize 闸，分层缺省：公共读（1）/
管理读（4，插件清单含原始配置、日志、文件）/ 变更（owner）。可对单个账户
grant `webui:files:read` 这类细粒度放行。

## 跨平台身份绑定

把外部平台身份（如 `onebot:12345`）绑定到 WebUI 主账户，证明"同一自然人"，
权限随账户走。语义与依据见
[multiuser-identity-survey](../architecture/multiuser-identity-survey.md)（2026-06-13 调研决议）。

- **流程**：WebUI 登录 → 权限页"绑定平台身份"生成 8 位码（一次性、5 分钟、
  重复生成作废旧码）→ 用外部平台账号**私聊** bot 发送 `/bind <码>`（非私聊
  拒绝，防码泄露）→ 绑定成立。解绑：权限页 ×，或 owner 代解。
- **运行时零合并**：被绑身份的等级/grants 直接解析到主账户记录（单一真源）；
  denies 取自身∪账户并集（防"绑定洗白封禁"）。
- **绑定时一次性合并**：平台身份原记录的等级(max)/grants/denies 并入账户；
  原记录留底不动，解绑即还原。
- 一个平台身份至多绑一个账户；webui/cli 身份不可被绑定。

## 高危操作确认（dangerous）

```
confirmDangerous(request)
  ├─ 白名单 isDangerousAllowed(name, permissions)（dangerousPolicy.allow + 限时策略）→ 通过
  ├─ 会话短时授权命中（consumeDangerousGrant，10min/N 次）→ 通过
  ├─ 平台确认处理器 confirmHandlers[platform]（CLI 终端 Y/N、WebUI 弹窗）→ 交互确认
  └─ 无处理器 → 拒绝
```

## 数据持久化（users.json v2）

```json
{
  "version": 2,
  "users": {
    "onebot:123456": { "level": 2 },
    "qq:789": { "level": 3, "grants": ["tool:file.*"], "denies": ["tool:shell.*"] },
    "webui:alice": { "level": 4, "secret": "pbkdf2:<iter>:<salt>:<hash>", "links": ["onebot:123456"] }
  }
}
```

v1 平面格式（`{"platform:userId": level}`）在 init() 时自动迁移，下次 save 写出 v2。

## 关键方法速览

```typescript
authority.authorize({ platform, userId }, { capabilities: ['tool:x'], declaredAuthority: 3 });
authority.getAuthority('onebot', '123456');          // → number
authority.setAuthority('onebot', '123456', 2);       // 设等级
authority.setUserCapabilities('qq', '789', { grants: ['tool:file.*'], denies: [] });
authority.removeUser('qq', '789');                   // 整条记录删除
await authority.setPassword('webui', 'alice', pw);   // 账户凭据
await authority.verifyPassword('webui', 'alice', pw);
authority.requiredAuthorityFor(['storage:path:data:/users.json:write']); // → 5
authority.listUsers();  // → [{ platform, userId, authority, grants?, denies?, hasPassword? }]
authority.save();       // 异步落盘 data:/users.json
```
