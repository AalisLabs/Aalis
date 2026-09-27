// ----- 托管侧车：拉起 laya-listener，退出后退避重启，停用时关掉 -----
//
// 何时托管由 index.ts 决定（配置了 sidecarDir、本插件是生效的触发插件、有 process 服务）。
// 目录布局与退出码是侧车的约定，见 models/listener-sidecar/README.md 与 laya_listener.py 的模块说明。

import type { ProcessService, SpawnHandle } from '@aalis/api-process';

/** 等侧车打出就绪行的上限：加载模型、金样自检与预热一般约 11s */
const STARTUP_TIMEOUT_MS = 120_000;
/** 退出后隔多久重启：从 1s 起每次翻倍，封顶 60s */
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
/** 就绪后连续运行这么久再退出，重启间隔回到起点 */
const STABLE_MS = 60_000;
/** 停侧车时先发 SIGTERM，这么久还没退出再发 SIGKILL */
const STOP_GRACE_MS = 5_000;
/** 退出原因里附带的最后一行输出的长度上限 */
const TAIL_MAX = 200;

/** 侧车退出码的含义（laya_listener.py 模块说明「退出码」） */
const EXIT_CODES: Record<number, string> = {
  2: '启动失败：加载模型或金样自检没过',
  3: '绑定端口失败',
  4: '自愈退出：推理连续失败',
  5: '父进程不是 --parent-pid 给的进程',
};

export type SidecarState =
  /** 已拉起，等就绪行；restarts = 此前连续退出的次数，0 为首次启动 */
  | { kind: 'starting'; since: number; restarts: number }
  | { kind: 'ready'; version: string }
  /** 退出后等着重启 */
  | { kind: 'waiting'; until: number; exit: string; restarts: number }
  /** 地址上已有别的侧车在答：不拉起，直接用它 */
  | { kind: 'external' }
  | { kind: 'stopped' };

interface SidecarOptions {
  process: ProcessService;
  /** 侧车目录（绝对路径） */
  dir: string;
  port: number;
  /** 本进程 pid：侧车发现父进程不是它（本进程已退出，侧车被系统收养）就自行退出 */
  parentPid: number;
  /** 侧车地址上是否已有侧车在答 /health */
  probe(): Promise<boolean>;
  log: { info(msg: string): void; warn(msg: string): void; debug(msg: string): void };
  /** 就绪：首次启动与每次重启后 */
  onReady(): void;
  /** 意外退出（含启动超时被杀）；reason 含退出码的含义、最后一行输出与重启时间 */
  onExit(reason: string): void;
}

export interface Sidecar {
  readonly state: SidecarState;
  /** 停掉侧车并等它退出；可重复调用 */
  stop(): Promise<void>;
}

/**
 * 托管的目标：侧车目录与端口。侧车只监听 127.0.0.1，端口取侧车地址的，所以地址必须是 http://127.0.0.1:<端口>；
 * 不合要求时返回原因，本插件不托管
 */
export function sidecarTarget(dir: string, endpoint: string): { dir: string; port: number } | { problem: string } {
  if (!dir.startsWith('/')) return { problem: `sidecarDir 须为绝对路径（当前: ${dir}）` };
  let url: URL | undefined;
  try {
    url = new URL(endpoint);
  } catch {
    // 下面按不合要求报
  }
  if (url?.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) {
    return {
      problem: `托管侧车时侧车地址须为 http://127.0.0.1:<端口>，侧车只监听本机、端口取自这里（当前: ${endpoint}）`,
    };
  }
  return { dir, port: Number(url.port) };
}

/** 按行回调；按 UTF-8 流式解码，跨块的多字节字符不会被切坏 */
function eachLine(stream: SpawnHandle['stdout'], fn: (line: string) => void): void {
  if (!stream) return;
  const decoder = new TextDecoder();
  let buf = '';
  stream.on('data', (chunk: Uint8Array) => {
    buf += decoder.decode(chunk, { stream: true });
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) fn(line);
      i = buf.indexOf('\n');
    }
  });
}

function parseJson(line: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(line);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function superviseSidecar(o: SidecarOptions): Sidecar {
  const python = `${o.dir}/.venv-run/bin/python`;
  const args = [
    '-u',
    `${o.dir}/laya_listener.py`,
    '--model-dir',
    `${o.dir}/models/current`,
    '--port',
    String(o.port),
    '--parent-pid',
    String(o.parentPid),
  ];

  let state: SidecarState = { kind: 'starting', since: Date.now(), restarts: 0 };
  let stopping = false;
  let child: SpawnHandle | undefined;
  /** 当前子进程退出（含拉起失败）时落定 */
  let exited: Promise<void> = Promise.resolve();
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let restarts = 0;
  let backoff = BACKOFF_BASE_MS;

  async function boot(): Promise<void> {
    // 地址上已有侧车（系统服务、手动启动的）：再拉一个只会绑定端口失败，不如直接用它
    const taken = await o.probe();
    if (stopping) return;
    if (taken) {
      state = { kind: 'external' };
      o.log.warn(
        `[laya] 侧车端口 ${o.port} 上已有侧车在运行（系统服务或手动启动的），本插件不再拉起，直接使用它；` +
          '要改由本插件托管，先停掉它，再重启 Aalis',
      );
      return;
    }
    spawn();
  }

  /** 意外退出（含拉起失败）：记下原因，隔一段时间重启；readyAt = 这次就绪的时刻，没就绪过为 undefined */
  function crashed(why: string, readyAt: number | undefined): void {
    child = undefined;
    if (stopping) return;
    // 就绪后稳定运行过一阵才退出的，算新一轮故障，重启间隔回到起点
    if (readyAt !== undefined && Date.now() - readyAt >= STABLE_MS) {
      restarts = 0;
      backoff = BACKOFF_BASE_MS;
    }
    restarts++;
    const delay = backoff;
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    state = { kind: 'waiting', until: Date.now() + delay, exit: why, restarts };
    o.onExit(`侧车退出（${why}），${delay / 1000}s 后重启`);
    restartTimer = setTimeout(() => {
      state = { kind: 'starting', since: Date.now(), restarts };
      o.log.debug(`[laya] 重启侧车（连续退出 ${restarts} 次）`);
      void boot();
    }, delay);
  }

  function spawn(): void {
    let handle: SpawnHandle;
    try {
      handle = o.process.spawn(python, args, { cwd: o.dir });
    } catch (err) {
      crashed(`拉起失败：${err}`, undefined);
      return;
    }
    child = handle;
    let readyAt: number | undefined;
    let lastLine = '';
    let timedOut = false;
    const startTimer = setTimeout(() => {
      timedOut = true;
      handle.kill('SIGKILL');
    }, STARTUP_TIMEOUT_MS);

    // 侧车日志只含事件名、计数、耗时与错误码，不含消息内容（laya_listener.py 的 log）
    eachLine(handle.stdout, line => {
      const ev = parseJson(line);
      if (ev?.ready !== true || state.kind !== 'starting' || child !== handle) {
        o.log.debug(`[laya] 侧车: ${line}`);
        return;
      }
      clearTimeout(startTimer);
      readyAt = Date.now();
      const after = state.restarts > 0 ? `，连续退出 ${state.restarts} 次后重启成功` : '';
      state = { kind: 'ready', version: typeof ev.version === 'string' ? ev.version : '?' };
      o.log.info(`[laya] 侧车就绪（版本 ${state.version}，启动 ${ev.startup_s ?? '?'}s${after}）`);
      o.onReady();
    });
    eachLine(handle.stderr, line => {
      lastLine = line;
      o.log.debug(`[laya] 侧车: ${line}`);
    });

    exited = handle
      .wait()
      .then(
        r =>
          timedOut
            ? `启动超时：${STARTUP_TIMEOUT_MS / 1000}s 内没有就绪`
            : r.signal
              ? `被信号 ${r.signal} 终止`
              : `退出码 ${r.code}${r.code !== null && EXIT_CODES[r.code] ? `，${EXIT_CODES[r.code]}` : ''}`,
        (err: unknown) => `拉起失败：${err}`,
      )
      .then(why => {
        clearTimeout(startTimer);
        crashed(lastLine ? `${why}；最后一行输出: ${lastLine.slice(0, TAIL_MAX)}` : why, readyAt);
      });
  }

  o.log.info(`[laya] 正在拉起侧车（${o.dir}，端口 ${o.port}），就绪前判定按兜底只回点名`);
  void boot();

  return {
    get state() {
      return state;
    },
    async stop() {
      if (!stopping) {
        stopping = true;
        clearTimeout(restartTimer);
        state = { kind: 'stopped' };
        const running = child;
        if (running) {
          running.kill('SIGTERM');
          const killTimer = setTimeout(() => running.kill('SIGKILL'), STOP_GRACE_MS);
          void exited.finally(() => clearTimeout(killTimer));
        }
      }
      await exited;
    },
  };
}
