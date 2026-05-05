import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';

import {
  MARKETPLACE_PROTOCOL_VERSION,
  ROUTES,
  verifyManifest,
  type AuditStatus,
  type PluginManifest,
  type PluginListResponse,
  type PluginDetailResponse,
} from '@aalis-marketplace/protocol';

import { StoreFs } from './store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ServerConfig {
  host: string;
  port: number;
  storeDir: string;
  /** admin API token；空表示开发期不校验。 */
  adminToken?: string;
}

export async function createServer(cfg: ServerConfig) {
  const app = Fastify({ logger: { level: 'info' } });
  const store = new StoreFs(cfg.storeDir);

  // ---- 公开 API -------------------------------------------------------------

  app.get(ROUTES.list, async (req): Promise<PluginListResponse> => {
    const items = await store.buildIndex();
    const filterAudit = (req.query as { audit?: AuditStatus | 'all' }).audit;
    const filtered = filterAudit && filterAudit !== 'all'
      ? items.filter(i => i.audit === filterAudit)
      : items;
    return {
      protocol: MARKETPLACE_PROTOCOL_VERSION,
      total: filtered.length,
      items: filtered,
      publishers: await store.listPublishers(),
    };
  });

  app.get('/v1/plugins/:name', async (req, reply): Promise<PluginDetailResponse | undefined> => {
    const name = decodeURIComponent((req.params as { name: string }).name);
    const versions = await store.listVersions(name);
    if (!versions.length) {
      reply.code(404).send({ error: 'not_found' });
      return;
    }
    const manifests: PluginManifest[] = [];
    for (const v of versions) {
      const m = await store.readManifest(name, v);
      if (m) manifests.push(m);
    }
    return {
      protocol: MARKETPLACE_PROTOCOL_VERSION,
      name,
      latest: manifests[0].version,
      versions: manifests,
    };
  });

  app.get('/v1/plugins/:name/:version/manifest', async (req, reply) => {
    const { name, version } = req.params as { name: string; version: string };
    const m = await store.readManifest(decodeURIComponent(name), decodeURIComponent(version));
    if (!m) return reply.code(404).send({ error: 'not_found' });
    return m;
  });

  app.get('/v1/plugins/:name/:version/tarball', async (req, reply) => {
    const { name, version } = req.params as { name: string; version: string };
    const buf = await store.readTarball(decodeURIComponent(name), decodeURIComponent(version));
    if (!buf) return reply.code(404).send({ error: 'not_found' });
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-disposition', `attachment; filename="${name}-${version}.tgz"`);
    return reply.send(buf);
  });

  app.get('/v1/publishers', async () => {
    return {
      protocol: MARKETPLACE_PROTOCOL_VERSION,
      publishers: await store.listPublishers(),
    };
  });

  // ---- 管理 API（带 token 鉴权） ------------------------------------------

  const checkAdmin = (req: { headers: Record<string, string | string[] | undefined> }): boolean => {
    if (!cfg.adminToken) return true;
    const auth = req.headers['authorization'];
    if (typeof auth !== 'string') return false;
    return auth === `Bearer ${cfg.adminToken}`;
  };

  app.post('/admin/publishers', async (req, reply) => {
    if (!checkAdmin(req)) return reply.code(401).send({ error: 'unauthorized' });
    const body = req.body as { id: string; name: string; publicKey: string; official?: boolean };
    if (!body?.id || !body?.name || !body?.publicKey) {
      return reply.code(400).send({ error: 'bad_request' });
    }
    await store.upsertPublisher({
      id: body.id,
      name: body.name,
      publicKey: body.publicKey,
      official: body.official === true ? true : undefined,
      createdAt: new Date().toISOString(),
    });
    return { ok: true };
  });

  app.post('/admin/audit', async (req, reply) => {
    if (!checkAdmin(req)) return reply.code(401).send({ error: 'unauthorized' });
    const body = req.body as { name: string; version: string; audit: AuditStatus };
    if (!body?.name || !body?.version || !body?.audit) {
      return reply.code(400).send({ error: 'bad_request' });
    }
    const m = await store.readManifest(body.name, body.version);
    if (!m) return reply.code(404).send({ error: 'not_found' });
    m.audit = body.audit;
    await store.writeManifest(m);
    return { ok: true };
  });

  // 接收 publish CLI 推送：tarball 在 body，manifest 通过 x-manifest 头（base64）。
  app.post(
    '/admin/publish',
    {
      bodyLimit: 50 * 1024 * 1024, // 50MB
    },
    async (req, reply) => {
      if (!checkAdmin(req)) return reply.code(401).send({ error: 'unauthorized' });
      const headerB64 = req.headers['x-manifest'];
      if (typeof headerB64 !== 'string') {
        return reply.code(400).send({ error: 'missing_x_manifest' });
      }
      let manifest: PluginManifest;
      try {
        manifest = JSON.parse(
          Buffer.from(headerB64, 'base64').toString('utf8'),
        ) as PluginManifest;
      } catch {
        return reply.code(400).send({ error: 'invalid_manifest' });
      }
      // 验签：manifest.signature.publisherKeyId 必须在 publishers 白名单内
      if (!manifest.signature) {
        return reply.code(400).send({ error: 'unsigned_manifest' });
      }
      const publishers = await store.listPublishers();
      const pub = publishers.find(p => p.id === manifest.signature!.publisherKeyId);
      if (!pub) {
        return reply.code(403).send({ error: 'unknown_publisher' });
      }
      if (!verifyManifest(manifest, pub.publicKey)) {
        return reply.code(403).send({ error: 'invalid_signature' });
      }
      // bundled 仅允许 official publisher 提交
      if (manifest.bundled && !pub.official) {
        return reply.code(403).send({ error: 'bundled_requires_official_publisher' });
      }
      // 默认审核状态 pending
      if (!manifest.audit) manifest.audit = 'pending';
      const tarball = req.body as Buffer;
      if (!Buffer.isBuffer(tarball)) {
        return reply.code(400).send({ error: 'tarball_required' });
      }
      await store.writeTarball(manifest.name, manifest.version, tarball);
      await store.writeManifest(manifest);
      return { ok: true, name: manifest.name, version: manifest.version };
    },
  );

  // 静态管理 UI
  await app.register(fastifyStatic, {
    root: resolve(__dirname, '../public'),
    prefix: '/admin/',
    decorateReply: false,
  });
  app.get('/', async (_req, reply) => reply.redirect('/admin/'));

  // 注册 octet-stream content-type parser
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),
  );

  await app.listen({ host: cfg.host, port: cfg.port });
  app.log.info(`Marketplace mock server listening on http://${cfg.host}:${cfg.port}`);
  return app;
}
