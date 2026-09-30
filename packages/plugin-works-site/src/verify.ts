import type { PagesClient, PagesDeployment } from './cloudflare/client.js';
import type { SiteAlert } from './state.js';

type PreflightClient = Pick<PagesClient, 'getProject' | 'listDomains' | 'listDeployments'>;
type PreflightConfig = { productionBranch: string; failOpen: boolean; mainOrigins: readonly string[] };
type PreflightIssue = Pick<SiteAlert, 'kind' | 'detail'> & { pause: boolean };

const KNOWN_BINDINGS = new Set([
  'env_vars',
  'kv_namespaces',
  'd1_databases',
  'r2_buckets',
  'durable_object_namespaces',
  'services',
  'queue_producers',
  'analytics_engine_datasets',
  'ai_bindings',
  'vectorize_bindings',
  'hyperdrive_bindings',
  'mtls_certificates',
  'browsers',
  'plain_text_bindings',
  'secret_text_bindings',
  'wasm_modules',
  'text_blobs',
  'data_blobs',
  'logfwdr',
  'tail_consumers',
  'dispatch_namespaces',
]);
const SETTINGS = new Set([
  'fail_open',
  'compatibility_date',
  'compatibility_flags',
  'placement',
  'usage_model',
  'limits',
  'build',
  'routes',
]);
const nonempty = (v: unknown): boolean =>
  v !== null &&
  v !== undefined &&
  v !== '' &&
  (!Array.isArray(v) || v.length > 0) &&
  (typeof v !== 'object' || Object.keys(v).length > 0);

export async function checkPreflight(
  client: PreflightClient,
  config: PreflightConfig,
  known: ReadonlySet<string>,
  inFlightId?: string,
  signal?: AbortSignal,
): Promise<{ pause: boolean; issues: PreflightIssue[]; deployments: PagesDeployment[]; onlineFailOpen?: boolean }> {
  const [project, domains, deployments] = await Promise.all([
    client.getProject(signal),
    client.listDomains(signal),
    client.listDeployments(signal),
  ]);
  const issues: PreflightIssue[] = [];
  const add = (kind: PreflightIssue['kind'], detail: string, pause: boolean) => issues.push({ kind, detail, pause });
  if (project.productionBranch !== config.productionBranch) add('settings', '生产分支与配置不符', true);
  for (const [name, settings] of Object.entries(project.deploymentConfigs)) {
    if (settings.fail_open !== config.failOpen) add('settings', `${name} 的 fail_open 与配置不符`, true);
    for (const [key, value] of Object.entries(settings)) {
      if (!nonempty(value) || key === 'fail_open') continue;
      if (KNOWN_BINDINGS.has(key)) add('settings', `${name} 存在 ${key} 绑定`, true);
      else if (!SETTINGS.has(key)) add('settings', `${name} 出现未知设置 ${key}`, false);
    }
  }
  // The domains endpoint lists custom domains; the project object separately carries pages.dev.
  const expected = config.mainOrigins
    .map(origin => new URL(origin).hostname)
    .filter(host => host !== project.subdomain)
    .sort();
  if (JSON.stringify([...domains].sort()) !== JSON.stringify(expected)) add('domains', '域名列表与配置不符', true);
  for (const deployment of deployments) {
    if (!known.has(deployment.id) && deployment.id !== inFlightId) {
      add('unknown-deployment', `发现账外部署 ${deployment.id.slice(0, 8)}`, true);
    }
  }
  return {
    pause: issues.some(issue => issue.pause),
    issues,
    deployments,
    onlineFailOpen: project.deploymentConfigs.production.fail_open as boolean | undefined,
  };
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function hashFiles(
  files: readonly { path: string; bytes: Uint8Array }[],
): Promise<Record<string, string>> {
  const result: Record<string, string> = Object.create(null);
  for (const file of files) result[file.path] = await sha256(file.bytes);
  return result;
}

export type ProbeFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** 分支 Worker 按 Sec-Fetch-Dest 分流；校验要命中访客实际使用的缓存变体。 */
function branchHeaders(path: string): Record<string, string> | undefined {
  const dest = path.endsWith('/')
    ? 'iframe'
    : /\.css$/i.test(path)
      ? 'style'
      : /\.(?:js|mjs)$/i.test(path)
        ? 'script'
        : /\.(?:png|jpe?g|gif|webp|svg)$/i.test(path)
          ? 'image'
          : /\.woff2$/i.test(path)
            ? 'font'
            : /\.mp4$/i.test(path)
              ? 'video'
              : undefined;
  return dest ? { 'Sec-Fetch-Dest': dest } : undefined;
}

export class ContentMismatchError extends Error {
  override name = 'ContentMismatchError';

  constructor(
    readonly path: string,
    readonly status: number,
    readonly expectedBytes: number,
    readonly expectedSha256: string,
    readonly actualBytes?: number,
    readonly actualSha256?: string,
  ) {
    super('线上文件内容与构建结果不符');
  }
}

export function contentMismatchDetail(error: ContentMismatchError): string {
  const path = error.path.replace(/(^|\/)v\/[^/]+\.txt$/, '$1v/[marker].txt');
  return `文件 ${path} HTTP ${error.status}，期望 ${error.expectedBytes} 字节 SHA-256 ${error.expectedSha256}，实际 ${error.actualBytes ?? '未知'} 字节 SHA-256 ${error.actualSha256 ?? '未知'}`;
}

export function abortablePause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener('abort', stop);
      resolve();
    }
    function stop() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener('abort', stop, { once: true });
  });
}

export async function waitForSwitch(
  fetcher: ProbeFetch,
  origin: string,
  nonce: string,
  signal: AbortSignal,
  options: { now?: () => number; pause?: (ms: number, signal: AbortSignal) => Promise<void>; timeoutMs?: number } = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const pause = options.pause ?? abortablePause;
  const deadline = now() + (options.timeoutMs ?? 60_000);
  while (!signal.aborted && now() < deadline) {
    const response = await fetcher(`${origin}/v/${nonce}.txt?t=${now()}`, { signal });
    if (signal.aborted) throw signal.reason;
    if (response.status === 200 && (await response.text()).trim() === nonce) return;
    await pause(Math.min(1000, deadline - now()), signal);
  }
  if (signal.aborted) throw signal.reason;
  throw new Error('部署别名切换确认超时');
}

export async function verifyContent(
  fetcher: ProbeFetch,
  origin: string,
  files: readonly {
    path: string;
    bytes: Uint8Array;
  }[],
  changed: readonly string[],
  branch: boolean,
  signal: AbortSignal,
  retryRequired: readonly string[] = [],
  alsoCanonical = false,
): Promise<void> {
  const required = new Set([...changed, ...retryRequired]);
  const unchanged = files.filter(file => !required.has(file.path));
  for (const file of unchanged.sort(() => Math.random() - 0.5).slice(0, 20)) required.add(file.path);
  for (const file of files) {
    if (!required.has(file.path)) continue;
    const expectedSha256 = await sha256(file.bytes);
    const directory = file.path.endsWith('/index.html') ? file.path.slice(0, -'index.html'.length) : undefined;
    for (const address of [
      `${origin}${file.path}?c=${crypto.randomUUID()}`,
      ...(alsoCanonical ? [`${origin}${file.path}`, ...(directory ? [`${origin}${directory}`] : [])] : []),
    ]) {
      if (signal.aborted) throw signal.reason;
      const response = await fetcher(address, {
        signal,
        headers: branch ? branchHeaders(file.path) : undefined,
      });
      if (signal.aborted) throw signal.reason;
      if (response.status !== 200)
        throw new ContentMismatchError(file.path, response.status, file.bytes.byteLength, expectedSha256);
      const actual = new Uint8Array(await response.arrayBuffer());
      const actualSha256 = await sha256(actual);
      if (signal.aborted) throw signal.reason;
      if (actualSha256 !== expectedSha256)
        throw new ContentMismatchError(
          file.path,
          response.status,
          file.bytes.byteLength,
          expectedSha256,
          actual.byteLength,
          actualSha256,
        );
    }
  }
}

export async function verifyContentUntilMatch(
  fetcher: ProbeFetch,
  origin: string,
  files: readonly { path: string; bytes: Uint8Array }[],
  changed: readonly string[],
  branch: boolean,
  signal: AbortSignal,
  options: {
    now?: () => number;
    pause?: (ms: number, signal: AbortSignal) => Promise<void>;
    timeoutMs?: number;
    pauseMs?: number;
    /** 同一轮还核对访客实际请求的无查询串路径；两类地址共用截止时间与失败重试集合。 */
    alsoCanonical?: boolean;
  } = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 3 * 60_000);
  const failedPaths = new Set<string>();
  while (true) {
    if (signal.aborted) throw signal.reason;
    try {
      await verifyContent(fetcher, origin, files, changed, branch, signal, [...failedPaths], options.alsoCanonical);
      return;
    } catch (err) {
      if (signal.aborted) throw signal.reason;
      if (!(err instanceof ContentMismatchError)) throw err;
      failedPaths.add(err.path);
      const remaining = deadline - now();
      if (remaining <= 0) throw err;
      await (options.pause ?? abortablePause)(Math.min(options.pauseMs ?? 3000, remaining), signal);
    }
  }
}
