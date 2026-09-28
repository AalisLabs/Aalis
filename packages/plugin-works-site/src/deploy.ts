import { isIntegrityError, type PublishedItem } from '@aalis/api-publish';
import type { Logger } from '@aalis/core';
import type { PagesClient, PagesDeployment } from './cloudflare/client.js';
import { PagesApiError } from './cloudflare/client.js';
import type { WorksSiteConfig } from './config.js';
import { buildBranch, buildGallery, type SiteBuild } from './site/build.js';
import type { CurrentDeployment, InFlightDeployment, SiteAlert, WorksState, WorksStore } from './state.js';
import {
  ContentMismatchError,
  checkPreflight,
  hashFiles,
  type ProbeFetch,
  sha256,
  verifyContent,
  waitForSwitch,
} from './verify.js';

const NEW_DELAY = 60_000;
const TOMBSTONE_LIFE = 8 * 24 * 60 * 60_000;
const RETRY_BASE = 30_000;
const MAX_RETRIES = 5;
const CHECK_INTERVAL = 60 * 60_000;
const CLEANUP_INTERVAL = 24 * 60 * 60_000;
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
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
const nonce = () => crypto.randomUUID().replaceAll('-', '');
const branchName = () =>
  `p-${Array.from(crypto.getRandomValues(new Uint8Array(4)), x => x.toString(16).padStart(2, '0')).join('')}`;

interface PublishPort {
  listPublished(surface: string): PublishedItem[];
  readFile(id: string, path: string): Promise<Uint8Array>;
  readThumbnail(id: string): Promise<Uint8Array>;
}
interface DeployerInput {
  config: WorksSiteConfig;
  store: WorksStore;
  client: PagesClient;
  publish: () => PublishPort | undefined;
  live: (ids: readonly string[]) => void;
  fetch?: ProbeFetch;
  logger: Pick<Logger, 'warn' | 'info'>;
  signal: AbortSignal;
  now?: () => number;
  debounceMs?: number;
  retryBaseMs?: number;
  convergenceMs?: number;
  convergencePauseMs?: number;
}

type Job = { kind: 'new' | 'withdraw'; branch: string; group?: string; works: PublishedItem[] };

export class WorksDeployer {
  readonly #config: WorksSiteConfig;
  readonly #store: WorksStore;
  readonly #client: PagesClient;
  readonly #publish: () => PublishPort | undefined;
  readonly #live: (ids: readonly string[]) => void;
  readonly #fetch: ProbeFetch;
  readonly #logger: Pick<Logger, 'warn' | 'info'>;
  readonly #signal: AbortSignal;
  readonly #stop = new AbortController();
  readonly #now: () => number;
  readonly #debounce: number;
  readonly #retryBase: number;
  readonly #convergenceMs: number;
  readonly #convergencePauseMs: number;
  #timer?: ReturnType<typeof setTimeout>;
  #checkTimer?: ReturnType<typeof setInterval>;
  #cleanupTimer?: ReturnType<typeof setInterval>;
  #running = false;
  #started = false;
  #sequenceTail: Promise<void> = Promise.resolve();
  #pending = false;
  #newDue = 0;
  #retryDue = 0;
  #retries = 0;
  onlineFailOpen?: boolean;
  tokenExpiresOn?: number;

  get active(): boolean {
    return this.#started && !this.#signal.aborted;
  }

  constructor(input: DeployerInput) {
    this.#config = input.config;
    this.#store = input.store;
    this.#client = input.client;
    this.#publish = input.publish;
    this.#live = input.live;
    this.#fetch = input.fetch ?? fetch;
    this.#logger = input.logger;
    this.#signal = AbortSignal.any([input.signal, this.#stop.signal]);
    this.#now = input.now ?? Date.now;
    this.#debounce = input.debounceMs ?? NEW_DELAY;
    this.#retryBase = input.retryBaseMs ?? RETRY_BASE;
    this.#convergenceMs = input.convergenceMs ?? 3 * 60_000;
    this.#convergencePauseMs = input.convergencePauseMs ?? 3000;
  }

  health(): { ok: true } | { ok: false; reason: string } {
    const state = this.#store.data;
    if (this.#store.failure || !state) return { ok: false, reason: this.#store.failure ?? '作品站状态文件读取失败' };
    if (state.paused) return { ok: false, reason: '作品站已暂停自动部署' };
    if (state.lastFailure === 'auth') return { ok: false, reason: 'Cloudflare 鉴权失败' };
    if (state.lastFailure === 'deploy-failed') return { ok: false, reason: '部署连续失败' };
    return { ok: true };
  }

  start(): void {
    if (this.#started || this.#signal.aborted || this.#store.failure) return;
    this.#started = true;
    this.#pending = true;
    this.#kick();
    this.#checkTimer = setInterval(() => {
      void this.checkPeriodic().catch(() => this.#backgroundFailure());
    }, CHECK_INTERVAL);
    this.#cleanupTimer = setInterval(() => {
      void this.cleanupTombstones().catch(() => this.#backgroundFailure());
    }, CLEANUP_INTERVAL);
  }

  change(): void {
    if (this.#signal.aborted) return;
    this.#pending = true;
    if (!this.#started) return;
    const state = this.#store.data;
    const published = this.#publish()?.listPublished('works') ?? [];
    const live = Object.values(state?.current ?? {}).flatMap(item => item.works);
    this.#newDue = this.#now() + this.#debounce;
    if (live.some(item => !published.some(next => next.id === item.id))) {
      this.#retryDue = 0;
      this.#kick();
    } else {
      this.#schedule(this.#debounce);
    }
  }

  retry(): void {
    if (this.#signal.aborted) return;
    this.#newDue = 0;
    this.#pending = true;
    this.#kick();
  }

  providerChanged(): void {
    this.retry();
  }

  async resume(): Promise<boolean> {
    this.#ensureActive();
    const resumed = await this.#store.update(state => {
      if (state.alerts.some(alert => !alert.acknowledged)) return false;
      state.paused = undefined;
      return true;
    });
    if (!resumed) return false;
    this.retry();
    return true;
  }

  async acknowledge(id: string): Promise<boolean> {
    this.#ensureActive();
    return this.#store.update(state => {
      const alert = state.alerts.find(item => item.id === id);
      if (!alert) return false;
      alert.acknowledged = true;
      return true;
    });
  }

  async alignSettings(): Promise<void> {
    this.#ensureActive();
    await this.#client.setFailOpen(this.#config.failOpen, this.#signal);
    await this.checkPeriodic();
  }

  async cleanupUnknown(): Promise<void> {
    this.#ensureActive();
    const state = this.#store.copy();
    const remote = await this.#client.listDeployments(this.#signal);
    // Rebuild all of ours before removing any remote deployment not recorded by this instance.
    if (!(await this.#serializedRun(true))) throw new Error('重新部署未完成，不清理账外部署');
    const latest = this.#store.copy();
    if (
      !latest.current[this.#config.productionBranch] ||
      latest.current[this.#config.productionBranch].id === state.current[this.#config.productionBranch]?.id
    )
      throw new Error('主站尚未重新部署，不清理账外部署');
    const currentIds = new Set(Object.values(latest.current).map(item => item.id));
    const ours = new Set(Object.keys(latest.known));
    const unknown = remote.filter(item => !ours.has(item.id) && !currentIds.has(item.id));
    const groupBranches = new Set(Object.values(latest.groups).map(item => item.branch));
    for (const item of unknown.sort((a, b) => (a.createdOn ?? 0) - (b.createdOn ?? 0))) {
      const force = item.branch !== this.#config.productionBranch && !groupBranches.has(item.branch ?? '');
      await this.#client.deleteDeployment(item.id, { force, signal: this.#signal });
    }
    await this.#store.update(next => {
      next.alerts = next.alerts.filter(alert => alert.kind !== 'unknown-deployment');
      if (next.paused?.reason.startsWith('发现账外部署')) next.paused = undefined;
    });
  }

  async stop(): Promise<void> {
    this.#stop.abort();
    this.#started = false;
    this.#pending = false;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#checkTimer) clearInterval(this.#checkTimer);
    if (this.#cleanupTimer) clearInterval(this.#cleanupTimer);
    // In-flight requests receive the combined abort signal; drain never waits for network.
  }

  #schedule(ms: number): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#kick(), Math.max(0, ms));
  }

  #kick(): void {
    if (this.#running || !this.active || !this.#pending) return;
    this.#running = true;
    void this.#loop()
      .finally(() => {
        this.#running = false;
        if (this.#pending && !this.#signal.aborted) this.#schedule(Math.max(0, this.#nextDue() - this.#now()));
      })
      .catch(() => {
        try {
          this.#logger.warn('作品站后台循环异常');
        } catch {
          /* no unhandled rejection on drain */
        }
      });
  }

  #ensureActive(): void {
    if (!this.active) throw new Error('作品站尚未启动或已停止');
  }

  #nextDue(): number {
    if (this.#retryDue > this.#now()) return this.#retryDue;
    if (this.#hasWithdrawal()) return 0;
    return Math.max(this.#store.data?.current[this.#config.productionBranch] ? this.#newDue : 0, this.#retryDue);
  }

  async #loop(): Promise<void> {
    while (this.#pending && !this.#signal.aborted) {
      if (this.#nextDue() > this.#now()) return;
      this.#pending = false;
      try {
        await this.#serializedRun(false);
      } catch (err) {
        if (this.#signal.aborted) return;
        if (isIntegrityError(err)) {
          this.#pending = true;
          continue;
        }
        await this.#recordFailure(err);
      }
    }
  }

  #serializedRun(force: boolean): Promise<boolean> {
    const run = this.#sequenceTail.then(() => {
      if (!this.#signal.aborted) return this.#runOnce(force);
      return false;
    });
    this.#sequenceTail = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async #runOnce(force: boolean): Promise<boolean> {
    const source = this.#publish();
    if (source && this.#store.copy().inFlight) await this.#resumeInFlight(source);
    if (!source) {
      await this.#pruneKnownCurrent();
      return false;
    }
    const published = source.listPublished('works');
    const initial = this.#store.copy();
    const withdrawn = [
      ...new Map(
        Object.values(initial.current)
          .flatMap(item => item.works)
          .filter(item => !published.some(next => next.id === item.id))
          .map(item => [item.id, item]),
      ).values(),
    ];
    if (withdrawn.length) {
      await this.#withdraw(source, withdrawn);
      this.#pending = true;
      return false;
    }
    if (!(await this.#pruneKnownCurrent())) return false;
    const currentState = this.#store.copy();
    if (this.#newDue > this.#now() && currentState.current[this.#config.productionBranch] && !force) {
      this.#pending = true;
      return false;
    }
    if (currentState.paused && !force) return false;
    const preflight = await checkPreflight(
      this.#client,
      this.#config,
      new Set(Object.keys(currentState.known)),
      currentState.inFlight?.id,
      this.#signal,
    );
    this.onlineFailOpen = preflight.onlineFailOpen;
    for (const issue of preflight.issues) await this.#alert(issue.kind, issue.detail, issue.pause);
    if (
      preflight.pause &&
      (!force || preflight.issues.some(issue => issue.pause && issue.kind !== 'unknown-deployment'))
    )
      return false;
    const groups = [...new Set(published.filter(item => item.kind === 'html').map(item => item.group))];
    for (const group of groups) {
      if (this.#hasWithdrawal()) {
        this.#pending = true;
        return false;
      }
      await this.#ensureGroup(group);
      const state = this.#store.copy();
      const branch = state.groups[group].branch;
      await this.#deployJob(
        source,
        { kind: 'new', branch, group, works: published.filter(item => item.group === group && item.kind === 'html') },
        force,
      );
    }
    if (this.#hasWithdrawal()) {
      this.#pending = true;
      return false;
    }
    await this.#deployJob(source, { kind: 'new', branch: this.#config.productionBranch, works: published }, force);
    return !this.#signal.aborted;
  }

  #hasWithdrawal(): boolean {
    const live = Object.values(this.#store.data?.current ?? {}).flatMap(item => item.works);
    const published = this.#publish()?.listPublished('works') ?? [];
    return live.some(item => !published.some(next => next.id === item.id));
  }

  async #ensureGroup(group: string): Promise<void> {
    await this.#store.update(state => {
      if (Object.hasOwn(state.groups, group)) return;
      const used = new Set(Object.values(state.groups).map(item => item.branch));
      let branch = branchName();
      while (used.has(branch)) branch = branchName();
      Object.defineProperty(state.groups, group, {
        value: { branch, createdAt: this.#now() },
        writable: true,
        enumerable: true,
        configurable: true,
      });
    });
  }

  async #withdraw(source: PublishPort, removed: PublishedItem[]): Promise<void> {
    await this.#store.update(state => {
      for (const item of removed) {
        const add = (branch: string, path: string) => {
          if (!state.tombstones.some(t => t.branch === branch && t.path === path))
            state.tombstones.push({ branch, path, until: this.#now() + TOMBSTONE_LIFE });
        };
        add('main', `/w/${item.id}/index.html`);
        if (item.kind === 'media') add('main', `/m/${item.id}.${item.files[0].path.split('.').at(-1)?.toLowerCase()}`);
        if (item.hasThumbnail) add('main', `/t/${item.id}.png`);
        if (item.kind === 'html') for (const file of item.files) add(item.group, `/${item.id}/${file.path}`);
      }
    });
    const state = this.#store.copy();
    const removedIds = new Set(removed.map(item => item.id));
    const currentMain = state.current[this.#config.productionBranch];
    if (currentMain?.works.some(item => removedIds.has(item.id)))
      await this.#deployJob(
        source,
        {
          kind: 'withdraw',
          branch: this.#config.productionBranch,
          works: currentMain.works.filter(item => !removedIds.has(item.id)),
        },
        true,
      );
    for (const [branch, previous] of Object.entries(this.#store.copy().current)) {
      if (branch === this.#config.productionBranch || !previous.works.some(item => removedIds.has(item.id))) continue;
      const group = Object.keys(state.groups).find(key => state.groups[key].branch === branch);
      if (!group) {
        await this.#alert('integrity', '撤下作品的组映射缺失', true);
        continue;
      }
      await this.#deployJob(
        source,
        { kind: 'withdraw', branch, group, works: previous.works.filter(item => !removedIds.has(item.id)) },
        true,
      );
    }
  }

  async #build(source: PublishPort, job: Job, token: string, state: WorksState): Promise<SiteBuild | undefined> {
    const common = {
      items: job.works,
      tombstones: state.tombstones,
      nonce: token,
      now: this.#now(),
      readFile: source.readFile.bind(source),
      readThumbnail: source.readThumbnail.bind(source),
    };
    if (job.group)
      return buildBranch({
        ...common,
        group: job.group,
        mainOrigin: this.#config.siteOrigin,
        frameAncestors: this.#config.mainOrigins,
      });
    const aliases: Record<string, string> = Object.create(null);
    for (const [group, value] of Object.entries(state.groups)) if (value.alias) aliases[group] = value.alias;
    return buildGallery({ ...common, aliases, siteTitle: this.#config.siteTitle, siteIntro: this.#config.siteIntro });
  }

  async #deployJob(source: PublishPort, job: Job, force: boolean): Promise<void> {
    if (this.#signal.aborted) return;
    const state = this.#store.copy();
    const token = nonce();
    const built = await this.#build(source, job, token, state);
    if (this.#signal.aborted) return;
    if (!built) return;
    const files = await hashFiles(built.files);
    files['/_headers'] = await sha256(new TextEncoder().encode(built.headers));
    if (built.worker) files['/_worker.js'] = await sha256(new TextEncoder().encode(built.worker));
    const previous = state.current[job.branch];
    const changed = built.files.filter(file => previous?.files[file.path] !== files[file.path]).map(file => file.path);
    const comparable = (value: Record<string, string>) =>
      Object.fromEntries(Object.entries(value).filter(([path]) => !path.startsWith('/v/') && path !== '/_worker.js'));
    if (
      !force &&
      previous &&
      JSON.stringify(comparable(previous.files)) === JSON.stringify(comparable(files)) &&
      JSON.stringify(previous.works) === JSON.stringify(job.works)
    )
      return;
    const inflight: InFlightDeployment = {
      kind: job.kind,
      branch: job.branch,
      nonce: token,
      at: this.#now(),
      files,
      works: job.works,
      changed,
    };
    await this.#store.update(next => {
      next.inFlight = inflight;
    });
    const deployed = await this.#client.deploy(
      { branch: job.branch, ...built, assetSalt: state.assetSalt },
      this.#signal,
    );
    if (this.#signal.aborted) return;
    const recorded = await this.#store.update(next => {
      if (!next.inFlight || next.inFlight.nonce !== token) throw new Error('部署状态并发改变');
      next.inFlight.id = deployed.id;
      next.known[deployed.id] = { branch: job.branch, at: this.#now() };
      return structuredClone(next.inFlight);
    });
    await this.#finish(recorded, built);
  }

  async #resumeInFlight(source: PublishPort): Promise<void> {
    const state = this.#store.copy();
    const inflight = state.inFlight;
    if (!inflight) return;
    if (!inflight.id) {
      const candidates = (await this.#client.listDeployments(this.#signal)).filter(
        d => d.branch === inflight.branch && (d.createdOn ?? 0) >= inflight.at,
      );
      const matching: PagesDeployment[] = [];
      for (const candidate of candidates) {
        const detail = await this.#client.getDeployment(candidate.id, this.#signal);
        if (detail.paths?.includes(`/v/${inflight.nonce}.txt`)) matching.push(detail);
      }
      if (this.#signal.aborted) return;
      if (matching.length > 1) {
        await this.#alert('unknown-deployment', '同一 nonce 对应多个部署', true);
        return;
      }
      if (matching.length === 0) {
        await this.#store.update(next => {
          if (next.inFlight?.nonce === inflight.nonce) next.inFlight = undefined;
        });
        this.#pending = true;
        return;
      }
      inflight.id = matching[0].id;
      await this.#store.update(next => {
        next.known[inflight.id!] = { branch: inflight.branch, at: inflight.at };
        next.inFlight = inflight;
      });
    }
    const group = Object.keys(state.groups).find(key => state.groups[key].branch === inflight.branch);
    const built = await this.#build(
      source,
      { kind: inflight.kind, branch: inflight.branch, group, works: inflight.works },
      inflight.nonce,
      state,
    );
    if (!built) throw new Error('在飞部署无法重建');
    await this.#finish(inflight, built);
  }

  async #finish(inflight: InFlightDeployment, built: SiteBuild): Promise<void> {
    if (!inflight.id) return;
    const deployed = await this.#client.waitForDeployment(inflight.id, this.#signal);
    if (this.#signal.aborted) return;
    const main = inflight.branch === this.#config.productionBranch;
    const alias = main ? undefined : this.#client.aliasOf(deployed);
    if (alias && !alias.ok) {
      await this.#alert('alias', '部署别名不合格', true);
      let cleaned = false;
      try {
        if (inflight.kind === 'withdraw') await this.#deleteOlder(inflight.branch, inflight.id);
        else await this.#client.deleteDeployment(inflight.id, { force: true, signal: this.#signal });
        cleaned = true;
      } catch {
        await this.#alert('deploy-failed', '旧部署清理失败', true);
        this.#needCleanupRetry();
      }
      await this.#store.update(state => {
        state.inFlight = undefined;
        if (inflight.kind === 'new' && cleaned) delete state.known[inflight.id!];
        if (inflight.kind === 'withdraw')
          state.current[inflight.branch] = {
            id: inflight.id!,
            branch: inflight.branch,
            nonce: inflight.nonce,
            at: this.#now(),
            files: inflight.files,
            works: inflight.works,
            verified: false,
          };
      });
      throw new Error('部署别名不合格');
    }
    const origin = alias?.ok ? alias.origin : this.#config.siteOrigin;
    try {
      await waitForSwitch(this.#fetch, origin, inflight.nonce, this.#signal);
      const contentFiles = main
        ? built.files
        : built.files.filter(
            file =>
              file.path.startsWith('/v/') ||
              inflight.works.some(item => item.files.some(part => file.path === `/${item.id}/${part.path}`)),
          );
      const canonical = (path: string) =>
        !main && /^\/[a-z2-7]{10}\/index\.html$/.test(path) ? path.slice(0, -'index.html'.length) : path;
      await verifyContent(
        this.#fetch,
        origin,
        contentFiles.map(file => ({ ...file, path: canonical(file.path) })),
        inflight.changed.map(canonical),
        !main,
        this.#signal,
      );
      await this.#probe(inflight, deployed, origin);
      if (this.#signal.aborted) return;
    } catch (err) {
      if (this.#signal.aborted) return;
      await this.#alert(err instanceof ContentMismatchError ? 'content' : 'probe', '部署后线上核对失败', true);
      let cleaned = false;
      try {
        if (inflight.kind === 'withdraw') await this.#deleteOlder(inflight.branch, inflight.id);
        else if (!main) await this.#client.deleteDeployment(inflight.id, { force: true, signal: this.#signal });
        cleaned = true;
      } catch {
        await this.#alert('deploy-failed', '旧部署清理失败', true);
        this.#needCleanupRetry();
      }
      await this.#store.update(state => {
        if (inflight.kind === 'withdraw')
          state.current[inflight.branch] = {
            id: inflight.id!,
            branch: inflight.branch,
            nonce: inflight.nonce,
            at: this.#now(),
            files: inflight.files,
            works: inflight.works,
            alias: main ? undefined : origin,
            verified: false,
          };
        else if (!main && cleaned) delete state.known[inflight.id!];
        state.inFlight = undefined;
        state.history.unshift({
          at: this.#now(),
          branch: inflight.branch,
          deployment: inflight.id!,
          result: inflight.kind === 'new' && !main && cleaned ? 'rolled-back' : 'failed',
        });
        state.history = state.history.slice(0, 50);
      });
      throw err;
    }
    const current: CurrentDeployment = {
      id: inflight.id,
      branch: inflight.branch,
      nonce: inflight.nonce,
      at: this.#now(),
      files: inflight.files,
      works: inflight.works,
      alias: main ? undefined : origin,
      verified: true,
    };
    await this.#store.update(state => {
      if (alias?.ok) {
        const group = Object.keys(state.groups).find(key => state.groups[key].branch === inflight.branch);
        if (group) {
          if (alias.label !== inflight.branch || (state.groups[group].alias && state.groups[group].alias !== origin)) {
            state.alerts.unshift({ id: nonce(), kind: 'alias', detail: '部署别名与分支名不一致', at: this.#now() });
          }
          state.groups[group].alias = origin;
        }
      }
      state.current[inflight.branch] = current;
      state.inFlight = undefined;
      state.lastFailure = undefined;
      state.history.unshift({ at: this.#now(), branch: inflight.branch, deployment: inflight.id!, result: 'live' });
      state.history = state.history.slice(0, 50);
    });
    this.#retries = 0;
    this.#retryDue = 0;
    try {
      await this.#deleteOlder(inflight.branch, inflight.id);
    } catch {
      await this.#alert('deploy-failed', '旧部署清理失败', true);
      this.#needCleanupRetry();
      return;
    }
    if (main) this.#live(inflight.works.map(item => item.id));
    if (main) void this.#converge(inflight, origin, built).catch(() => this.#backgroundFailure());
  }

  async #deleteOlder(branch: string, latestId: string): Promise<void> {
    const list = await this.#client.listDeployments(this.#signal);
    const remote = new Set(list.map(item => item.id));
    const remoteLatest = list.find(item => item.branch === branch)?.id;
    for (const [id, known] of Object.entries(this.#store.copy().known)) {
      if (known.branch === branch && id !== latestId && id !== this.#store.data?.inFlight?.id && !remote.has(id)) {
        await this.#store.update(state => {
          delete state.known[id];
        });
      }
    }
    for (const deployed of list) {
      if (deployed.branch !== branch || deployed.id === latestId || deployed.id === this.#store.data?.inFlight?.id)
        continue;
      if (!this.#store.data?.known[deployed.id]) continue;
      // Cloudflare refuses deletion of the active production deployment, even with force.
      // A failed new main stays in known until a later main deployment replaces it.
      if (branch === this.#config.productionBranch && deployed.id === remoteLatest) continue;
      try {
        await this.#client.deleteDeployment(deployed.id, {
          force: deployed.id === remoteLatest && deployed.id !== latestId,
          signal: this.#signal,
        });
      } catch (err) {
        if (!(err instanceof PagesApiError && err.kind === 'not-found')) throw err;
      }
      await this.#store.update(state => {
        delete state.known[deployed.id];
      });
    }
  }

  async #pruneKnownCurrent(): Promise<boolean> {
    const orphanBranches = [...new Set(Object.values(this.#store.copy().known).map(item => item.branch))].filter(
      branch => branch !== this.#config.productionBranch && !this.#store.data?.current[branch],
    );
    for (const branch of orphanBranches) {
      try {
        await this.#deleteOrphanBranch(branch);
      } catch (err) {
        if (this.#signal.aborted) return false;
        if (err instanceof PagesApiError && err.kind === 'auth') await this.#recordFailure(err);
        else {
          await this.#alert('deploy-failed', '旧部署清理失败', true);
          this.#needCleanupRetry();
        }
        return false;
      }
    }
    for (const current of Object.values(this.#store.copy().current)) {
      if (
        !Object.entries(this.#store.copy().known).some(
          ([id, known]) =>
            known.branch === current.branch && id !== current.id && id !== this.#store.data?.inFlight?.id,
        )
      )
        continue;
      try {
        await this.#deleteOlder(current.branch, current.id);
      } catch (err) {
        if (this.#signal.aborted) return false;
        if (err instanceof PagesApiError && err.kind === 'auth') await this.#recordFailure(err);
        else {
          await this.#alert('deploy-failed', '旧部署清理失败', true);
          this.#needCleanupRetry();
        }
        return false;
      }
    }
    if (this.#store.data?.paused?.reason === '旧部署清理失败') {
      await this.#store.update(state => {
        if (state.paused?.reason === '旧部署清理失败') state.paused = undefined;
      });
    }
    this.#retryDue = 0;
    const main = this.#store.data?.current[this.#config.productionBranch];
    if (main?.verified) this.#live(main.works.map(item => item.id));
    return true;
  }

  async #deleteOrphanBranch(branch: string): Promise<void> {
    const list = (await this.#client.listDeployments(this.#signal)).filter(item => item.branch === branch);
    const tracked = Object.keys(this.#store.copy().known).filter(
      id => this.#store.data?.known[id]?.branch === branch && id !== this.#store.data?.inFlight?.id,
    );
    for (const item of list) {
      if (!tracked.includes(item.id)) continue;
      try {
        await this.#client.deleteDeployment(item.id, { force: true, signal: this.#signal });
      } catch (err) {
        if (!(err instanceof PagesApiError && err.kind === 'not-found')) throw err;
      }
      await this.#store.update(state => {
        delete state.known[item.id];
      });
    }
    for (const id of tracked) {
      if (!list.some(item => item.id === id))
        await this.#store.update(state => {
          delete state.known[id];
        });
    }
  }

  #needCleanupRetry(): void {
    if (this.#signal.aborted) return;
    this.#retryDue = this.#now() + this.#retryBase;
    this.#pending = true;
    this.#schedule(this.#retryBase);
  }

  async #probe(inflight: InFlightDeployment, deployed: PagesDeployment, origin: string): Promise<void> {
    const main = inflight.branch === this.#config.productionBranch;
    const hashOrigin = main ? undefined : this.#client.hashOriginOf(deployed);
    if (!main && !hashOrigin) throw new Error('部署哈希网址不合格');
    const origins = main ? [origin] : [origin, hashOrigin!];
    for (const base of origins) {
      const missing = await this.#fetch(`${base}/unknown-${nonce()}?c=${nonce()}`, { signal: this.#signal });
      if (missing.status !== 404 || !missing.headers.get('content-security-policy'))
        throw new Error('未知路径探测失败');
      if (main) {
        const home = await this.#fetch(`${base}/?c=${nonce()}`, { signal: this.#signal });
        if (
          home.status !== 200 ||
          !home.headers.get('content-security-policy') ||
          !home.headers.get('x-robots-tag') ||
          home.headers.has('access-control-allow-origin')
        )
          throw new Error('主站探测失败');
        for (const item of inflight.works) {
          const wrapper = await this.#fetch(`${base}/w/${item.id}/?c=${nonce()}`, { signal: this.#signal });
          if (wrapper.status !== 200 || !wrapper.headers.get('content-security-policy'))
            throw new Error('主站作品页探测失败');
        }
      } else {
        const id = inflight.works.find(item => item.kind === 'html')?.id;
        const post = await this.#fetch(`${base}/?c=${nonce()}`, { method: 'POST', signal: this.#signal });
        if (post.status !== 405) throw new Error('作品分支方法探测失败');
        const previous = this.#store.data?.current[inflight.branch]?.works ?? [];
        for (const removed of previous.filter(item => !inflight.works.some(work => work.id === item.id))) {
          const response = await this.#fetch(`${base}/${removed.id}/?c=${nonce()}`, {
            signal: this.#signal,
            headers: { 'Sec-Fetch-Dest': 'iframe' },
          });
          if (response.status !== 404 || !response.headers.get('content-security-policy'))
            throw new Error('撤下作品仍可访问');
        }
        if (!id) continue;
        const iframe = await this.#fetch(`${base}/${id}/?c=${nonce()}`, {
          signal: this.#signal,
          headers: { 'Sec-Fetch-Dest': 'iframe' },
        });
        if (
          iframe.status !== 200 ||
          !iframe.headers.get('content-security-policy')?.includes('sandbox allow-scripts') ||
          !iframe.headers.get('content-security-policy')?.includes(`/${id}/`) ||
          !iframe.headers.get('vary')?.toLowerCase().includes('sec-fetch-dest')
        )
          throw new Error('作品沙箱探测失败');
        const document = await this.#fetch(`${base}/${id}/?c=${nonce()}`, {
          signal: this.#signal,
          headers: { 'Sec-Fetch-Dest': 'document' },
          redirect: 'manual',
        });
        if (document.status !== 302 || !document.headers.get('location')?.startsWith(this.#config.siteOrigin))
          throw new Error('作品顶层跳转探测失败');
        const notice = await this.#fetch(`${base}/${id}/?c=${nonce()}`, { signal: this.#signal });
        if (notice.status !== 200 || !notice.headers.get('content-security-policy'))
          throw new Error('作品直接打开探测失败');
        for (const path of [
          `/${id}`,
          `/${id}/index.html`,
          `/${id.toUpperCase()}/`,
          `//${id}/`,
          `/%${id.charCodeAt(0).toString(16)}${id.slice(1)}/`,
        ]) {
          const rejected = await this.#fetch(`${base}${path}?c=${nonce()}`, {
            signal: this.#signal,
            headers: { 'Sec-Fetch-Dest': 'iframe' },
          });
          if (rejected.status !== 404 || !rejected.headers.get('content-security-policy'))
            throw new Error('作品路径隔离探测失败');
        }
      }
    }
  }

  async #converge(inflight: InFlightDeployment, origin: string, built: SiteBuild): Promise<void> {
    const changed = new Set(inflight.changed);
    const files = built.files.filter(
      file => changed.has(file.path) && (file.path === '/index.html' || /\/(?:w|m|t)\//.test(file.path)),
    );
    if (!files.length) return;
    const deadline = this.#now() + this.#convergenceMs;
    while (!this.#signal.aborted && this.#now() < deadline) {
      try {
        let ready = true;
        for (const file of files) {
          const response = await this.#fetch(`${origin}${file.path}`, { signal: this.#signal });
          if (
            response.status !== 200 ||
            (await sha256(new Uint8Array(await response.arrayBuffer()))) !== (await sha256(file.bytes))
          ) {
            ready = false;
            break;
          }
        }
        if (ready) return;
        await sleep(this.#convergencePauseMs, this.#signal);
      } catch {
        return;
      }
    }
    if (!this.#signal.aborted) await this.#alert('cache-lag', '访客缓存三分钟内未收敛', false);
  }

  async checkPeriodic(): Promise<void> {
    if (this.#signal.aborted || this.#store.failure) return;
    try {
      const state = this.#store.copy();
      const result = await checkPreflight(
        this.#client,
        this.#config,
        new Set(Object.keys(state.known)),
        state.inFlight?.id,
        this.#signal,
      );
      this.onlineFailOpen = result.onlineFailOpen;
      for (const issue of result.issues) await this.#alert(issue.kind, issue.detail, issue.pause);
      const token = await this.#client.verifyToken(this.#signal);
      this.tokenExpiresOn = token.expiresOn;
      if (token.expiresOn && token.expiresOn <= this.#now())
        await this.#alert('auth', 'Cloudflare token 已过期', false);
    } catch (err) {
      if (this.#signal.aborted) return;
      if (err instanceof PagesApiError && err.kind === 'auth') {
        await this.#store.update(state => {
          state.lastFailure = 'auth';
        });
        await this.#alert('auth', 'Cloudflare 鉴权失败', false);
      } else await this.#alert('settings', '定时核对失败', false);
    }
  }

  async cleanupTombstones(): Promise<void> {
    if (this.#signal.aborted || this.#store.failure) return;
    const changed = await this.#store.update(state => {
      const before = state.tombstones.length;
      state.tombstones = state.tombstones.filter(item => item.until > this.#now());
      return state.tombstones.length !== before;
    });
    if (changed) this.retry();
  }

  async #alert(kind: SiteAlert['kind'], detail: string, pause: boolean): Promise<void> {
    if (this.#signal.aborted) return;
    await this.#store.update(state => {
      if (!state.alerts.some(a => !a.acknowledged && a.kind === kind && a.detail === detail)) {
        state.alerts.unshift({ id: nonce(), kind, detail, at: this.#now() });
        state.alerts = state.alerts.slice(0, 100);
      }
      if (pause) state.paused = { reason: detail, at: this.#now() };
    });
    this.#logger.warn(`作品站：${detail}`);
  }

  async #recordFailure(err: unknown): Promise<void> {
    if (this.#signal.aborted) return;
    const auth = err instanceof PagesApiError && err.kind === 'auth';
    if (auth) {
      await this.#store.update(state => {
        state.lastFailure = 'auth';
      });
      await this.#alert('auth', 'Cloudflare 鉴权失败', false);
      return;
    }
    if (this.#store.data?.paused) return;
    this.#retries++;
    if (this.#retries <= MAX_RETRIES) {
      this.#retryDue = this.#now() + this.#retryBase * 2 ** (this.#retries - 1);
      this.#pending = true;
    } else {
      await this.#store.update(state => {
        state.lastFailure = 'deploy-failed';
      });
      await this.#alert('deploy-failed', '部署连续失败', false);
    }
  }

  #backgroundFailure(): void {
    try {
      this.#logger.warn('作品站后台状态更新失败');
    } catch {
      /* no unhandled rejection */
    }
  }
}
