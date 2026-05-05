# Aalis Marketplace (mock)

本地用于开发联调的插件市场服务端，未来会拆为独立仓库。

## 包

- `packages/protocol`：manifest / 索引 / 签名工具，客户端与服务端共享。
- `packages/cli`：发布 CLI（`npm pack` → 计算 sha256 → Ed25519 签名 → 入库 / 推送到 server）。
- `apps/server`：Fastify HTTP 服务，提供：
  - 客户端 API：`GET /v1/plugins`、`GET /v1/plugins/:name`、`GET /v1/plugins/:name/:version/manifest`、`GET /v1/plugins/:name/:version/tarball`
  - 管理 API：`POST /admin/publishers`、`POST /admin/audit`
  - 静态管理 UI：`/admin`

## 协议要点

- Manifest 含 `tarball.sha256` 和可选 `signature(Ed25519)`。
- 服务端按发布者公钥白名单签发 manifest；客户端根据其内置/配置的 root key 验签。
- 审核状态：`pending` / `approved` / `blocked`，客户端可按策略过滤。

## 起步

```bash
cd marketplace
pnpm install
pnpm keygen                      # 生成发布者密钥对
pnpm dev:server                  # 起 mock 服务（默认 http://127.0.0.1:7820）
pnpm publish:plugin <plugin-dir> # 发布一个本地包到 store
```
