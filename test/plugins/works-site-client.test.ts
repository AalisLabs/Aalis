import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type DeployFile,
  PagesApiError,
  PagesClient,
  type PagesClientOptions,
  type PagesDeployment,
  type PagesErrorKind,
} from '../../packages/plugin-works-site/src/cloudflare/client.js';
import { assetKey, newAssetSalt } from '../../packages/plugin-works-site/src/cloudflare/hash.js';
import { type FakePages, startFakePages } from '../fixtures/fake-pages.js';

// ════════════════════════════════════════════════════════════
// plugin-works-site 的 Cloudflare Pages 客户端（Direct Upload、部署、项目、域名、删除、token 核验）。
// 一律对本机假服务（test/fixtures/fake-pages.ts），不连真实账号。
//
// 全文件用同一个哨兵 token：各用例的日志与抛出的错误都收进 captured，最后一组断言里面找不到 token、
// 上传 JWT 与资产键的任何 8 字以上片段；假服务记下的请求里 token 只出现在 API 端点的 Authorization 头。
// ════════════════════════════════════════════════════════════

const TOKEN = 'cf-sentinel-Tk7Qw2Er9Ty4Ui8Op3As6Df1Gh5Jk0Lz';
const USER_TOKEN = 'cf-placeholder-user-token-0000000000000001';
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const SALT = 'a1'.repeat(32);
const MIB = 1024 * 1024;

const captured: string[] = [];

function render(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

const logger = {
  debug: (m: string, ...a: unknown[]) => captured.push([m, ...a.map(render)].join(' ')),
  info: (m: string, ...a: unknown[]) => captured.push([m, ...a.map(render)].join(' ')),
  warn: (m: string, ...a: unknown[]) => captured.push([m, ...a.map(render)].join(' ')),
};

let fake: FakePages;
const life = new AbortController();

function makeClient(overrides: Partial<PagesClientOptions> = {}): PagesClient {
  return new PagesClient({
    accountId: ACCOUNT,
    apiToken: TOKEN,
    projectName: 'aalis',
    logger,
    signal: life.signal,
    apiBase: fake.apiBase,
    hostSuffix: fake.hostSuffix,
    protocol: 'http:',
    ratePerSecond: 1000,
    retryBaseMs: 10,
    pollIntervalMs: 50,
    deployTimeoutMs: 5_000,
    ...overrides,
  });
}

async function expectKind(p: Promise<unknown>, kind: PagesErrorKind): Promise<PagesApiError> {
  let caught: unknown;
  try {
    await p;
  } catch (err) {
    caught = err;
  }
  captured.push(render(caught));
  expect(caught, `应抛 PagesApiError，实际：${render(caught)}`).toBeInstanceOf(PagesApiError);
  expect((caught as PagesApiError).kind, (caught as Error).message).toBe(kind);
  return caught as PagesApiError;
}

function textFile(path: string, content: string, contentType = 'text/css'): DeployFile {
  return { path, bytes: new TextEncoder().encode(content), contentType };
}

function uploadPayloads(): Array<Array<{ key: string; value: string; metadata: { contentType: string } }>> {
  return fake.requestsTo('POST', /\/pages\/assets\/upload$/).map(r => JSON.parse(r.body.toString('utf-8')));
}

/** 部署一个只有一个文件的分支并等到完成 */
async function quickDeploy(
  client: PagesClient,
  branch: string,
  content = `x${Math.random()}`,
): Promise<PagesDeployment> {
  const created = await client.deploy({ branch, files: [textFile('/a.css', content)], assetSalt: SALT });
  return client.waitForDeployment(created.id);
}

beforeAll(async () => {
  fake = await startFakePages({ accountId: ACCOUNT });
});

afterAll(async () => {
  life.abort();
  await fake.close();
});

beforeEach(() => {
  fake.tokens.clear();
  fake.tokens.set(TOKEN, { kind: 'account' });
  fake.queuedMs = 100;
  fake.nextOutcomes = [];
  fake.aliasFor = undefined;
  fake.jwtTtlMs = 30 * 60_000;
});

describe('资产键', () => {
  it('同盐同内容同扩展名得同一个键；换盐、换扩展名、换内容都得不同的键；恰为 32 位小写十六进制', async () => {
    const bytes = new TextEncoder().encode('<p>作品</p>');
    const k = await assetKey(SALT, 'html', bytes);
    expect(k).toMatch(/^[0-9a-f]{32}$/);
    expect(await assetKey(SALT, 'html', new TextEncoder().encode('<p>作品</p>'))).toBe(k);
    expect(await assetKey('b2'.repeat(32), 'html', bytes)).not.toBe(k);
    expect(await assetKey(SALT, 'css', bytes)).not.toBe(k);
    expect(await assetKey(SALT, 'html', new TextEncoder().encode('<p>作品 </p>'))).not.toBe(k);
  });

  it('键不是不带盐就能算出的值（无盐 HMAC 与裸 SHA-256 都对不上）', async () => {
    const bytes = new TextEncoder().encode('removed\n');
    const k = await assetKey(SALT, 'png', bytes);
    const data = new Uint8Array([...new TextEncoder().encode('png'), 0, ...bytes]);
    const bare = Buffer.from(await crypto.subtle.digest('SHA-256', data))
      .toString('hex')
      .slice(0, 32);
    const emptyKey = await crypto.subtle.importKey('raw', new Uint8Array(1), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ]);
    const unsalted = Buffer.from(await crypto.subtle.sign('HMAC', emptyKey, data))
      .toString('hex')
      .slice(0, 32);
    expect(k).not.toBe(bare);
    expect(k).not.toBe(unsalted);
  });

  it('新盐是 32 字节随机数的十六进制，两次不同；格式不对的盐直接拒', async () => {
    const a = newAssetSalt();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(newAssetSalt()).not.toBe(a);
    await expect(assetKey('not-hex', 'css', new Uint8Array(1))).rejects.toThrow();
  });
});

describe('部署全流程', () => {
  it('2001 个新文件分两批上传，manifest、branch、_headers、_worker.bundle 的结构正确，轮询到 success', async () => {
    const client = makeClient();
    const files = Array.from({ length: 2001 }, (_, i) => textFile(`/f/${i}.css`, `a{--i:${i}}`));
    const before = fake.requests.length;
    const created = await client.deploy({
      branch: 'p-abcdefgh',
      files,
      headers: '/*\n  X-Test: 1\n',
      worker: 'export default { fetch() { return new Response("ok"); } };\n',
      assetSalt: SALT,
    });
    expect(created.stage.status).not.toBe('success');
    const done = await client.waitForDeployment(created.id);
    expect(done.stage).toEqual({ name: 'deploy', status: 'success' });
    expect(done.environment).toBe('preview');
    expect(done.branch).toBe('p-abcdefgh');

    const reqs = fake.requests.slice(before);
    expect(reqs.filter(r => r.path.endsWith('/upload-token'))).toHaveLength(1);
    expect(reqs.filter(r => r.path === '/client/v4/pages/assets/check-missing')).toHaveLength(1);
    const batches = uploadPayloads();
    expect(batches.map(b => b.length).sort((a, b) => b - a)).toEqual([2000, 1]);
    expect(reqs.filter(r => r.path === '/client/v4/pages/assets/upsert-hashes')).toHaveLength(1);
    // 轮询：queued 期间至少取了两次
    expect(
      reqs.filter(r => r.method === 'GET' && r.path.includes(`/deployments/${created.id}`)).length,
    ).toBeGreaterThan(1);

    const d = fake.deployments.find(x => x.id === created.id)!;
    expect(Object.keys(d.manifest)).toHaveLength(2001);
    for (const [i, f] of files.entries()) {
      const key = d.manifest[`/f/${i}.css`];
      expect(key).toBe(await assetKey(SALT, 'css', f.bytes));
      expect(Buffer.from(fake.assets.get(key)!.bytes).toString()).toBe(`a{--i:${i}}`);
      expect(fake.assets.get(key)!.contentType).toBe('text/css');
    }
    expect(d.branch).toBe('p-abcdefgh');
    expect(d.headers).toBe('/*\n  X-Test: 1\n');
    expect(d.worker?.metadata.main_module).toBe('_worker.js');
    expect(d.worker?.modules['_worker.js']).toEqual({
      type: 'application/javascript+module',
      content: 'export default { fetch() { return new Response("ok"); } };\n',
    });
    // 上传的每一项：键、base64 内容、contentType
    const item = batches.flat().find(x => x.key === d.manifest['/f/7.css'])!;
    expect(Buffer.from(item.value, 'base64').toString()).toBe('a{--i:7}');
    expect(item.metadata.contentType).toBe('text/css');
  });

  it('已有的键不重传：第二次部署只上传新增的文件', async () => {
    const client = makeClient();
    const base = [textFile('/keep/a.css', 'keep-a'), textFile('/keep/b.css', 'keep-b')];
    await client.waitForDeployment((await client.deploy({ branch: 'p-keepkeep', files: base, assetSalt: SALT })).id);
    const before = fake.requestsTo('POST', /\/pages\/assets\/upload$/).length;
    const added = textFile('/keep/c.css', 'keep-c');
    await client.waitForDeployment(
      (await client.deploy({ branch: 'p-keepkeep', files: [...base, added], assetSalt: SALT })).id,
    );
    const uploads = uploadPayloads().slice(before);
    expect(uploads.flat().map(x => x.key)).toEqual([await assetKey(SALT, 'css', added.bytes)]);
  });

  it('生产分支的部署不带 _worker.bundle，是生产部署、没有别名', async () => {
    const client = makeClient();
    const created = await client.deploy({
      branch: 'main',
      files: [textFile('/index.html', '<!doctype html><title>t</title>', 'text/html; charset=utf-8')],
      headers: '/*\n  X-Frame-Options: DENY\n',
      assetSalt: SALT,
    });
    const done = await client.waitForDeployment(created.id);
    expect(done.environment).toBe('production');
    expect(done.aliases).toEqual([]);
    const d = fake.deployments.find(x => x.id === created.id)!;
    expect(d.worker).toBeUndefined();
    const last = fake.requestsTo('POST', /\/deployments$/).at(-1)!;
    expect(last.body.toString('latin1')).not.toContain('_worker.bundle');
  });

  it('部署以 failure 结束或一直 queued 超过时限：按失败报', async () => {
    const client = makeClient({ deployTimeoutMs: 400 });
    fake.nextOutcomes = ['failure'];
    const failed = await client.deploy({ branch: 'p-failfail', files: [textFile('/a.css', 'f1')], assetSalt: SALT });
    await expectKind(client.waitForDeployment(failed.id), 'deploy-failed');
    fake.nextOutcomes = ['stuck'];
    const stuck = await client.deploy({ branch: 'p-failfail', files: [textFile('/a.css', 'f2')], assetSalt: SALT });
    await expectKind(client.waitForDeployment(stuck.id), 'deploy-failed');
  });

  it('详情里有文件路径（不带资产键），列表里没有', async () => {
    const client = makeClient();
    const done = await quickDeploy(client, 'p-detailxx', 'detail');
    const detail = await client.getDeployment(done.id);
    expect(detail.paths).toEqual(['/a.css']);
    expect(JSON.stringify(detail)).not.toContain(await assetKey(SALT, 'css', new TextEncoder().encode('detail')));
    const listed = (await client.listDeployments()).find(d => d.id === done.id)!;
    expect(listed.paths).toBeUndefined();
  });
});

describe('本地先挡', () => {
  it('单文件 25 MiB 加 1 字节在本地被拒、不发请求', async () => {
    const client = makeClient();
    const before = fake.requests.length;
    const big: DeployFile = { path: '/m/big.mp4', bytes: new Uint8Array(25 * MIB + 1), contentType: 'video/mp4' };
    await expectKind(client.deploy({ branch: 'p-bigbigbi', files: [big], assetSalt: SALT }), 'invalid');
    expect(fake.requests.length).toBe(before);
  });

  it('超过 20000 个文件、路径不合规、路径重复、保留文件名都在本地被拒、不发请求', async () => {
    const client = makeClient();
    const before = fake.requests.length;
    const many = Array.from({ length: 20_001 }, (_, i) => textFile(`/n/${i}.css`, ''));
    await expectKind(client.deploy({ branch: 'p-manyfile', files: many, assetSalt: SALT }), 'invalid');
    for (const path of [
      'a.css',
      '/a/../b.css',
      '/a//b.css',
      '/a/./b.css',
      '/',
      '/_worker.js',
      '/_headers',
      '/x\0.css',
    ]) {
      await expectKind(
        client.deploy({ branch: 'p-badpathx', files: [textFile(path, 'x')], assetSalt: SALT }),
        'invalid',
      );
    }
    await expectKind(
      client.deploy({
        branch: 'p-duppathx',
        files: [textFile('/a.css', '1'), textFile('/a.css', '2')],
        assetSalt: SALT,
      }),
      'invalid',
    );
    expect(fake.requests.length).toBe(before);
  });

  it('凭据格式不对（如被写成掩码）：每个调用都按鉴权失败报、不发请求；构造时不报错', async () => {
    const before = fake.requests.length;
    const masked = makeClient({ apiToken: '••••••' });
    await expectKind(masked.getProject(), 'auth');
    await expectKind(masked.verifyToken(), 'auth');
    const badAccount = makeClient({ accountId: '../../user' });
    await expectKind(badAccount.getProject(), 'auth');
    await expectKind(badAccount.deploy({ branch: 'p-xxxxxxxx', files: [], assetSalt: SALT }), 'auth');
    expect(fake.requests.length).toBe(before);
  });
});

describe('限速、退避与重试', () => {
  it('429 按 Retry-After 退避后重试', async () => {
    const client = makeClient();
    fake.intercept('GET', '/client/v4/accounts/0123456789abcdef0123456789abcdef/pages/projects/aalis', {
      status: 429,
      body: { success: false, errors: [{ code: 971, message: 'rate limited' }] },
      headers: { 'Retry-After': '1' },
    });
    const before = fake.requestsTo('GET', /\/pages\/projects\/aalis$/).length;
    const t0 = Date.now();
    const project = await client.getProject();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
    expect(project.name).toBe('aalis');
    expect(fake.requestsTo('GET', /\/pages\/projects\/aalis$/).length - before).toBe(2);
  });

  it('资产接口回 401 时重取 JWT 一次、接着走完', async () => {
    const client = makeClient();
    fake.intercept('POST', '/client/v4/pages/assets/check-missing', {
      status: 401,
      body: { success: false, errors: [{ code: 8000013, message: 'Unauthorized' }] },
    });
    const before = fake.requestsTo('GET', /\/upload-token$/).length;
    const done = await quickDeploy(client, 'p-jwtjwtjw', 'jwt-once');
    expect(done.stage.status).toBe('success');
    expect(fake.requestsTo('GET', /\/upload-token$/).length - before).toBe(2);
  });

  it('重取的 JWT 仍被拒：按鉴权失败报，只重取一次', async () => {
    const client = makeClient();
    fake.jwtTtlMs = -1;
    const before = fake.requestsTo('GET', /\/upload-token$/).length;
    await expectKind(
      client.deploy({ branch: 'p-jwtdeadx', files: [textFile('/a.css', 'dead')], assetSalt: SALT }),
      'auth',
    );
    expect(fake.requestsTo('GET', /\/upload-token$/).length - before).toBe(2);
  });

  it('5xx：幂等的请求重试；建部署不重试（可能已建成，由调用方按 nonce 认领）', async () => {
    const client = makeClient();
    fake.intercept('GET', /\/pages\/projects\/aalis\/domains$/, { status: 502, body: '<html>bad gateway</html>' });
    const before = fake.requestsTo('GET', /\/domains$/).length;
    expect(await client.listDomains()).toEqual([]);
    expect(fake.requestsTo('GET', /\/domains$/).length - before).toBe(2);

    fake.intercept('POST', /\/pages\/projects\/aalis\/deployments$/, { status: 500, body: '<html>oops</html>' });
    const posts = fake.requestsTo('POST', /\/deployments$/).length;
    await expectKind(
      client.deploy({ branch: 'p-fivexxxx', files: [textFile('/a.css', '5xx')], assetSalt: SALT }),
      'transient',
    );
    expect(fake.requestsTo('POST', /\/deployments$/).length - posts).toBe(1);
  });

  it('5xx 一直不好：重试用完后按临时故障报', async () => {
    const client = makeClient();
    fake.intercept('GET', /\/domains$/, { status: 503, body: 'unavailable' }, 10);
    await expectKind(client.listDomains(), 'transient');
    fake.clearIntercepts();
  });

  it('按令牌桶限速：超过每秒次数的请求要等', async () => {
    const client = makeClient({ ratePerSecond: 10 });
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 15 }, () => client.listDomains()));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
  });
});

describe('删除部署', () => {
  it('非最新直接删；最新的要 force；当前生产部署报「不能删」', async () => {
    const client = makeClient();
    const d1 = await quickDeploy(client, 'p-delete01', 'd1');
    const d2 = await quickDeploy(client, 'p-delete01', 'd2');
    const d3 = await quickDeploy(client, 'p-delete01', 'd3');
    await client.deleteDeployment(d1.id);
    expect(fake.deployments.find(d => d.id === d1.id)?.deleted).toBe(true);
    const refused = await expectKind(client.deleteDeployment(d3.id), 'rejected');
    expect(refused.code).toBe(8000035);
    await client.deleteDeployment(d3.id, { force: true });
    expect(fake.deployments.find(d => d.id === d3.id)?.deleted).toBe(true);
    expect(fake.deployments.find(d => d.id === d2.id)?.deleted).toBe(false);

    const prod = await quickDeploy(client, 'main', 'prod-only');
    const err = await expectKind(client.deleteDeployment(prod.id, { force: true }), 'rejected');
    expect(err.message).toContain('不能删');
    await expectKind(client.deleteDeployment('00000000-0000-4000-8000-000000000000'), 'not-found');
  });
});

describe('项目、域名、部署列表与 token 核验', () => {
  it('读项目：生产分支、两套部署配置原样给出', async () => {
    const client = makeClient();
    fake.project.deployment_configs.preview.kv_namespaces = { CACHE: { namespace_id: 'placeholder' } };
    const project = await client.getProject();
    expect(project.productionBranch).toBe('main');
    expect(project.deploymentConfigs.production.fail_open).toBe(true);
    expect(project.deploymentConfigs.preview.kv_namespaces).toEqual({ CACHE: { namespace_id: 'placeholder' } });
    expect(project.domains).toContain('aalis.pages.dev');
    delete fake.project.deployment_configs.preview.kv_namespaces;
  });

  it('PATCH fail_open 同时改 production 与 preview', async () => {
    const client = makeClient();
    const project = await client.setFailOpen(false);
    expect(project.deploymentConfigs.production.fail_open).toBe(false);
    expect(project.deploymentConfigs.preview.fail_open).toBe(false);
    expect(fake.project.deployment_configs.production.fail_open).toBe(false);
    expect(fake.project.deployment_configs.preview.fail_open).toBe(false);
    const patch = fake.requestsTo('PATCH', /\/pages\/projects\/aalis$/).at(-1)!;
    expect(JSON.parse(patch.body.toString('utf-8'))).toEqual({
      deployment_configs: { production: { fail_open: false }, preview: { fail_open: false } },
    });
    await client.setFailOpen(true);
  });

  it('域名列表', async () => {
    const client = makeClient();
    fake.customDomains = ['works.example.invalid'];
    expect(await client.listDomains()).toEqual(['works.example.invalid']);
    fake.customDomains = [];
  });

  it('部署列表取完所有页、不重复', async () => {
    const client = makeClient();
    for (let i = 0; i < 60; i++) fake.seedDeployment({ branch: `p-seed${String(i).padStart(4, '0')}` });
    const all = await client.listDeployments();
    const alive = fake.deployments.filter(d => !d.deleted);
    expect(all).toHaveLength(alive.length);
    expect(new Set(all.map(d => d.id)).size).toBe(alive.length);
    expect(fake.requestsTo('GET', /\/deployments$/).some(r => r.path.includes('page=3'))).toBe(true);
    const seeded = all.find(d => d.branch === 'p-seed0000')!;
    expect(seeded.environment).toBe('preview');
    expect(typeof seeded.createdOn).toBe('number');
  });

  it('token 核验：账号级 token 走账号端点、带过期时间；用户 token 回落到用户端点', async () => {
    fake.tokens.set(TOKEN, { kind: 'account', expiresOn: '2027-01-01T00:00:00Z' });
    expect(await makeClient().verifyToken()).toEqual({
      kind: 'account',
      status: 'active',
      expiresOn: Date.parse('2027-01-01T00:00:00Z'),
    });
    fake.tokens.set(USER_TOKEN, { kind: 'user' });
    expect(await makeClient({ apiToken: USER_TOKEN }).verifyToken()).toEqual({ kind: 'user', status: 'active' });
    expect(fake.requestsTo('GET', '/client/v4/user/tokens/verify').at(-1)?.headers.authorization).toBe(
      `Bearer ${USER_TOKEN}`,
    );
    fake.tokens.delete(TOKEN);
    await expectKind(makeClient().verifyToken(), 'auth');
  });

  it('API token 失效：按鉴权失败报', async () => {
    fake.tokens.delete(TOKEN);
    await expectKind(makeClient().getProject(), 'auth');
    await expectKind(makeClient().deploy({ branch: 'p-noauthxx', files: [], assetSalt: SALT }), 'auth');
  });
});

describe('别名', () => {
  it('合格的别名照用', async () => {
    const client = makeClient();
    const done = await quickDeploy(client, 'p-aliasok1', 'alias-ok');
    const alias = client.aliasOf(done);
    expect(alias).toEqual({
      ok: true,
      label: 'p-aliasok1',
      host: `p-aliasok1${fake.hostSuffix}`,
      origin: `http://p-aliasok1${fake.hostSuffix}`,
    });
    expect(client.hashOriginOf(done)).toMatch(
      new RegExp(`^http://[0-9a-f]{8}${fake.hostSuffix.replace(/\./g, '\\.')}$`),
    );
  });

  it('冲突时带后缀的别名仍合格（是否与分支名一致由调用方判）', async () => {
    const client = makeClient();
    await quickDeploy(client, 'P_Suffix', 'suffix-1');
    const second = await quickDeploy(client, 'p-suffix', 'suffix-2');
    const alias = client.aliasOf(second);
    expect(alias.ok).toBe(true);
    expect(alias.ok && alias.label).toMatch(/^p-suffix-[a-z0-9]{4}$/);
  });

  it('未注入 http 协议时 http:// 开头的别名被拒', async () => {
    const client = makeClient({ protocol: undefined });
    const done = await quickDeploy(makeClient(), 'p-httpxxxx', 'http-alias');
    expect(client.aliasOf(done).ok).toBe(false);
  });

  it('主机后缀不对、段里有非法字符、段超长、多段、带路径或查询、大写、没有或多于一个别名都被拒', async () => {
    const client = makeClient();
    const base = await quickDeploy(client, 'p-aliasbad', 'alias-bad');
    const cases = [
      `http://p-aliasbad.other.localhost:${fake.port}`,
      `http://p-aliasbad.aalis.localhost:${fake.port + 1}`,
      `http://p_aliasbad${fake.hostSuffix}`,
      `http://${'a'.repeat(64)}${fake.hostSuffix}`,
      `http://a.b${fake.hostSuffix}`,
      `http://p-aliasbad${fake.hostSuffix}/x`,
      `http://p-aliasbad${fake.hostSuffix}/?q=1`,
      `http://user@p-aliasbad${fake.hostSuffix}`,
      `http://P-ALIASBAD${fake.hostSuffix}`,
      `javascript:alert(1)//p-aliasbad${fake.hostSuffix}`,
      'not a url',
    ];
    for (const raw of cases) {
      expect(client.aliasOf({ ...base, aliases: [raw] }), raw).toMatchObject({ ok: false });
    }
    expect(client.aliasOf({ ...base, aliases: [] }).ok).toBe(false);
    const good = base.aliases[0];
    expect(client.aliasOf({ ...base, aliases: [good, good.replace('p-aliasbad', 'p-other00')] }).ok).toBe(false);

    fake.aliasFor = () => `http://evil.example.invalid${fake.hostSuffix.slice(fake.hostSuffix.indexOf(':'))}`;
    const viaFake = await client.getDeployment(base.id);
    expect(client.aliasOf(viaFake).ok).toBe(false);
  });
});

describe('构造与凭据', () => {
  it('构造函数不发任何网络请求', async () => {
    const before = fake.requests.length;
    makeClient();
    await new Promise(r => setTimeout(r, 50));
    expect(fake.requests.length).toBe(before);
  });

  it('错误信息回显的 token、JWT、资产键片段都被去掉', async () => {
    const client = makeClient();
    // API 端点：假服务在 401 里回显 token 的前 12 个字符
    fake.tokens.delete(TOKEN);
    const e1 = await expectKind(client.getProject(), 'auth');
    expect(e1.message).not.toContain(TOKEN.slice(0, 12));
    fake.tokens.set(TOKEN, { kind: 'account' });
    // 资产端点：假服务在 401 里回显 JWT 的前 24 个字符
    fake.jwtTtlMs = -1;
    const e2 = await expectKind(
      client.deploy({ branch: 'p-echojwtx', files: [textFile('/a.css', 'echo')], assetSalt: SALT }),
      'auth',
    );
    expect(e2.message).not.toMatch(/eyJ[A-Za-z0-9_-]{8}/);
    fake.jwtTtlMs = 30 * 60_000;
    // 资产键：错误体里带着这次要上传的键
    const key = await assetKey(SALT, 'css', new TextEncoder().encode('echo-key'));
    fake.intercept('POST', '/client/v4/pages/assets/check-missing', {
      status: 400,
      body: { success: false, errors: [{ code: 8000000, message: `bad hash ${key} for account ${ACCOUNT}` }] },
    });
    const e3 = await expectKind(
      client.deploy({ branch: 'p-echokeyx', files: [textFile('/a.css', 'echo-key')], assetSalt: SALT }),
      'rejected',
    );
    expect(e3.message).not.toContain(key);
    expect(e3.message).not.toContain(ACCOUNT);
    expect(e3.message).toContain('bad hash');
    // 错误体截到 500 字
    fake.intercept('GET', /\/pages\/projects\/aalis$/, { status: 400, body: `<html>${'x'.repeat(3000)}</html>` });
    const e4 = await expectKind(client.getProject(), 'rejected');
    expect(e4.message.length).toBeLessThan(700);
  });
});

describe('凭据不外泄（收尾扫描）', () => {
  function fragments(secret: string, len = 8): string[] {
    const out: string[] = [];
    for (let i = 0; i + len <= secret.length; i++) out.push(secret.slice(i, i + len));
    return out;
  }

  it('日志与错误里找不到 token、账号 ID、JWT 与资产键；错误体截到 500 字', () => {
    const text = captured.join('\n');
    expect(captured.length).toBeGreaterThan(10);
    for (const f of fragments(TOKEN)) expect(text).not.toContain(f);
    expect(text).not.toContain(ACCOUNT);
    const jwts = new Set(
      fake.requests
        .filter(r => r.path.startsWith('/client/v4/pages/assets/'))
        .map(r => String(r.headers.authorization ?? '').replace(/^Bearer /, ''))
        .filter(Boolean),
    );
    expect(jwts.size).toBeGreaterThan(0);
    for (const jwt of jwts) for (const f of fragments(jwt, 16)) expect(text).not.toContain(f);
    for (const key of fake.assets.keys()) expect(text).not.toContain(key);
  });

  it('假服务记下的请求里，token 只出现在 API 端点的 Authorization 头；资产端点从没收到 token', () => {
    for (const r of fake.requests) {
      const { authorization, ...rest } = r.headers;
      const elsewhere = `${r.path}\n${JSON.stringify(rest)}\n${r.body.toString('latin1')}`;
      for (const f of fragments(TOKEN)) expect(elsewhere, `${r.method} ${r.path}`).not.toContain(f);
      if (r.path.startsWith('/client/v4/pages/assets/')) expect(authorization).not.toContain(TOKEN);
    }
  });
});
