import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type RequestListener, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  askPicks,
  CHAT_MODELS,
  createPrompter,
  defaultPicks,
  EMBEDDINGS,
  MEMORY_BACKENDS,
  ollamaHost,
  PLATFORMS,
  type Prompter,
  parseYesNo,
  probeOllama,
  VECTORSTORES,
} from '../../packages/create-aalis/src/cli.js';
import { parseYesNo as parsePluginYesNo } from '../../packages/create-aalis-plugin/src/cli.js';

// create-aalis 的提问流程：默认只问对话模型（要 key 的当场粘贴）、接入平台与要不要语义记忆；
// --advanced 另问记忆后端、embedding 与向量库。默认答案看本机有没有 Ollama。

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../../packages/create-aalis/src/cli.ts', import.meta.url));
const tsx = createRequire(import.meta.url).resolve('tsx');

const DEEPSEEK = '@aalis/plugin-llm-deepseek';
const OLLAMA = '@aalis/plugin-llm-ollama';
const OPENAI_EMBEDDING = '@aalis/plugin-embedding-openai';
const OLLAMA_EMBEDDING = '@aalis/plugin-embedding-ollama';
const FLAT = '@aalis/plugin-vectorstore-flat';
const LANCEDB = '@aalis/plugin-vectorstore-lancedb';
const names = (options: ReadonlyArray<{ name: string }>) => options.map(o => o.name);

interface Call {
  kind: 'choose' | 'chooseMany' | 'confirm' | 'secret';
  title: string;
  options?: string[];
  def?: unknown;
}

/** 按顺序回答：undefined 取默认，密钥给 undefined 即跳过；记下问了什么 */
function scripted(replies: unknown[] = []): { prompter: Prompter; calls: Call[] } {
  const calls: Call[] = [];
  const next = () => replies.shift();
  const prompter: Prompter = {
    text: async () => {
      throw new Error('提问流程不问文字');
    },
    choose: async (title, options, def) => {
      calls.push({ kind: 'choose', title, options: names(options), def });
      const name = (next() as string | undefined) ?? def;
      return options.find(o => o.name === name)!;
    },
    chooseMany: async (title, options, defs) => {
      calls.push({ kind: 'chooseMany', title, options: names(options), def: defs });
      return (next() as string[] | undefined) ?? [...defs];
    },
    confirm: async (title, def) => {
      calls.push({ kind: 'confirm', title, def });
      return (next() as boolean | undefined) ?? def;
    },
    secret: async title => {
      calls.push({ kind: 'secret', title });
      return (next() as string | undefined) ?? '';
    },
    close() {},
  };
  return { prompter, calls };
}

describe('默认流程的提问', () => {
  it('没探到 Ollama：问对话模型（默认 DeepSeek）、它的 key、平台（默认 CLI 与 WebUI）、语义记忆（默认不要）', async () => {
    const { prompter, calls } = scripted([undefined, 'sk-pasted']);
    const result = await askPicks(prompter, { tier: 'standard', advanced: false, ollama: false, lancedb: true });
    expect(calls.map(c => c.kind)).toEqual(['choose', 'secret', 'chooseMany', 'confirm']);
    expect(calls[0]).toMatchObject({ options: names(CHAT_MODELS), def: DEEPSEEK });
    expect(calls[1].title).toContain('DeepSeek');
    expect(calls[1].title).toContain('apiKey');
    expect(calls[2]).toMatchObject({
      options: names(PLATFORMS),
      def: ['@aalis/plugin-cli', '@aalis/plugin-webui-server'],
    });
    expect(calls[3].def).toBe(false);
    expect(result.picks).toEqual(defaultPicks('standard', false));
    expect(result.keys).toEqual({ [DEEPSEEK]: { apiKey: 'sk-pasted' } });
  });

  it('跳过的 key 不写进结果；答「要」语义记忆又没有 Ollama 时用 OpenAI Embedding、请粘贴它的 key', async () => {
    const { prompter, calls } = scripted([undefined, undefined, undefined, true, 'sk-embed']);
    const result = await askPicks(prompter, { tier: 'standard', advanced: false, ollama: false, lancedb: true });
    expect(calls.map(c => c.kind)).toEqual(['choose', 'secret', 'chooseMany', 'confirm', 'secret']);
    expect(calls[4].title).toContain('OpenAI Embedding');
    expect(result.picks.semantic).toEqual({ embedding: OPENAI_EMBEDDING, vectorstore: FLAT });
    expect(result.keys).toEqual({ [OPENAI_EMBEDDING]: { apiKey: 'sk-embed' } });
  });

  it('探到 Ollama：对话模型默认它、不问 key，语义记忆默认要并用 Ollama Embedding', async () => {
    const { prompter, calls } = scripted();
    const result = await askPicks(prompter, { tier: 'standard', advanced: false, ollama: true, lancedb: true });
    expect(calls.map(c => c.kind)).toEqual(['choose', 'chooseMany', 'confirm']);
    expect(calls[0].def).toBe(OLLAMA);
    expect(calls[2].def).toBe(true);
    expect(result.picks).toEqual(defaultPicks('standard', true));
    expect(result.picks.semantic).toEqual({ embedding: OLLAMA_EMBEDDING, vectorstore: FLAT });
    expect(result.keys).toEqual({});
  });

  it('没探到 Ollama 但对话模型选了它：语义记忆同样用 Ollama Embedding，不问 key', async () => {
    const { prompter, calls } = scripted([OLLAMA, undefined, true]);
    const result = await askPicks(prompter, { tier: 'standard', advanced: false, ollama: false, lancedb: true });
    expect(calls.map(c => c.kind)).toEqual(['choose', 'chooseMany', 'confirm']);
    expect(result.picks.semantic).toEqual({ embedding: OLLAMA_EMBEDDING, vectorstore: FLAT });
  });
});

describe('--advanced 的提问', () => {
  it('standard：多问记忆后端、embedding 与向量库；没有 LanceDB 预编译件的平台不列它', async () => {
    const { prompter, calls } = scripted([undefined, undefined, undefined, undefined, true]);
    const result = await askPicks(prompter, { tier: 'standard', advanced: true, ollama: false, lancedb: false });
    expect(calls.map(c => c.kind)).toEqual([
      'choose',
      'secret',
      'chooseMany',
      'choose',
      'confirm',
      'choose',
      'secret',
      'choose',
    ]);
    expect(calls[3]).toMatchObject({ options: names(MEMORY_BACKENDS), def: '@aalis/plugin-memory-sqlite' });
    expect(calls[5]).toMatchObject({ options: names(EMBEDDINGS), def: OPENAI_EMBEDDING });
    expect(calls[7]).toMatchObject({ options: [FLAT], def: FLAT });
    expect(result.picks.semantic).toEqual({ embedding: OPENAI_EMBEDDING, vectorstore: FLAT });
  });

  it('有预编译件的平台列出 LanceDB，选了就装它', async () => {
    const { prompter, calls } = scripted([
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      undefined,
      undefined,
      LANCEDB,
    ]);
    const result = await askPicks(prompter, { tier: 'standard', advanced: true, ollama: false, lancedb: true });
    expect(calls[7].options).toEqual(names(VECTORSTORES));
    expect(result.picks.semantic?.vectorstore).toBe(LANCEDB);
  });

  it('minimal：问对话模型、key、平台与记忆后端，不问语义记忆', async () => {
    const { prompter, calls } = scripted([undefined, undefined, '@aalis/plugin-memory-inmemory']);
    const result = await askPicks(prompter, { tier: 'minimal', advanced: true, ollama: true, lancedb: true });
    expect(calls.map(c => c.kind)).toEqual(['choose', 'chooseMany', 'choose']);
    expect(result.picks).toEqual({ ...defaultPicks('minimal', true), memory: '@aalis/plugin-memory-inmemory' });
    expect(result.picks.semantic).toBeUndefined();
  });
});

describe('终端提问', () => {
  /** 伪终端：输入流，以及写到终端上的全部文字 */
  function terminal() {
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = '';
    output.on('data', chunk => {
      shown += String(chunk);
    });
    const prompter = createPrompter(input, output);
    /** 敲一行字：等提问流程处理完再敲下一行 */
    const type = async (line: string) => {
      input.write(`${line}\r`);
      await new Promise(resolve => setImmediate(resolve));
    };
    return { prompter, type, shown: () => shown };
  }

  it('粘贴 key：输入不回显，读到的值与输入逐字相同', async () => {
    const t = terminal();
    const value = t.prompter.secret('粘贴 DeepSeek 的 apiKey');
    const key = 'sk-a"b\\c:d #e\'f';
    await t.type(key);
    expect(await value).toBe(key);
    expect(t.shown()).toContain('粘贴 DeepSeek 的 apiKey');
    expect(t.shown()).not.toContain('sk-a');
    // 回显关掉之后照常恢复：下一问的输入看得到
    const name = t.prompter.text('项目目录名', 'my-aalis-bot', () => ({ ok: true }));
    await t.type('my-bot');
    expect(await name).toBe('my-bot');
    expect(t.shown()).toContain('my-bot');
    t.prompter.close();
  });

  it('单选：回车取默认；坏输入说明原因后重问', async () => {
    const t = terminal();
    const first = t.prompter.choose('对话模型', CHAT_MODELS, DEEPSEEK);
    await t.type('');
    expect((await first).name).toBe(DEEPSEEK);
    const second = t.prompter.choose('对话模型', CHAT_MODELS, DEEPSEEK);
    await t.type('1,2');
    expect(t.shown()).toContain('这是单选');
    await t.type('3');
    expect((await second).name).toBe(OLLAMA);
    t.prompter.close();
  });

  it('多选与是否：回车取默认，序号与 y/n 照输入', async () => {
    const t = terminal();
    const platforms = t.prompter.chooseMany('接入平台', PLATFORMS, ['@aalis/plugin-cli']);
    await t.type('3 1');
    expect(await platforms).toEqual(['@aalis/plugin-adapter-onebot', '@aalis/plugin-cli']);
    const yes = t.prompter.confirm('要长期语义记忆吗', false);
    await t.type('maybe');
    expect(t.shown()).toContain('请输入 y 或 n');
    await t.type('y');
    expect(await yes).toBe(true);
    t.prompter.close();
  });

  it('是否的判定与插件脚手架一致', () => {
    for (const answer of ['', 'y', 'YES', 'n', 'no', 'maybe', '1', '0']) {
      for (const def of [true, false]) expect(parseYesNo(answer, def), answer).toBe(parsePluginYesNo(answer, def));
    }
  });
});

describe('Ollama 的地址与探测', () => {
  it.each([
    [undefined, undefined],
    ['', undefined],
    ['127.0.0.1:11435', 'http://127.0.0.1:11435'],
    ['0.0.0.0', 'http://0.0.0.0:11434'],
    ['ollama.lan', 'http://ollama.lan:11434'],
    ['http://ollama.lan:9000/', 'http://ollama.lan:9000'],
    ['http://ollama.lan', 'http://ollama.lan'],
    ['https://ollama.example.com/ollama', 'https://ollama.example.com/ollama'],
    ['[::1]:8080', 'http://[::1]:8080'],
  ])('OLLAMA_HOST=%j → %j（与 Ollama 自己的解析一致：不写协议时默认端口 11434）', (raw, expected) => {
    expect(ollamaHost(raw)).toBe(expected);
  });

  it('解析不了的 OLLAMA_HOST 写明怎么改', () => {
    expect(() => ollamaHost('a b')).toThrow('OLLAMA_HOST');
  });

  const servers: Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  async function serve(handler: RequestListener): Promise<string> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('未监听 TCP');
    return `http://127.0.0.1:${address.port}`;
  }

  /** 假 Ollama：/api/tags 列 tags 里的模型，/api/show 按 capabilities 答（没写的模型回 404） */
  function fakeOllama(capabilities: Record<string, string[]>, tags = Object.keys(capabilities)) {
    return serve((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/tags') {
        response.end(JSON.stringify({ models: tags.map(name => ({ name })) }));
        return;
      }
      expect(request.url).toBe('/api/show');
      let body = '';
      request.on('data', chunk => {
        body += chunk;
      });
      request.on('end', () => {
        const caps = capabilities[(JSON.parse(body) as { model: string }).model];
        response.statusCode = caps ? 200 : 404;
        response.end(JSON.stringify(caps ? { capabilities: caps } : { error: 'model not found' }));
      });
    });
  }

  it('探到时给出已有的模型与有没有对话模型；回应不像 Ollama 的不算', async () => {
    const ollama = await fakeOllama({ 'qwen3:8b': ['completion', 'tools'], 'nomic-embed-text:latest': ['embedding'] });
    expect(await probeOllama(ollama)).toEqual({
      base: ollama,
      models: ['qwen3:8b', 'nomic-embed-text:latest'],
      chat: true,
    });
    const other = await serve((_request, response) => {
      response.statusCode = 404;
      response.end('not found');
    });
    expect(await probeOllama(other)).toBeNull();
  });

  it('有没有对话模型与 Ollama 对话模型插件同一判据：只有嵌入模型不算；查不到能力的照对话模型算；一个模型都没有不算', async () => {
    const embeddingOnly = await fakeOllama({
      'nomic-embed-text:latest': ['embedding'],
      'qwen3-embedding:4b': ['embedding'],
    });
    expect((await probeOllama(embeddingOnly))?.chat).toBe(false);
    const unknown = await fakeOllama({ 'nomic-embed-text:latest': ['embedding'] }, [
      'nomic-embed-text:latest',
      'mystery:1b',
    ]);
    expect((await probeOllama(unknown))?.chat).toBe(true);
    const empty = await fakeOllama({});
    expect(await probeOllama(empty)).toEqual({ base: empty, models: [], chat: false });
  });

  it('一直不回应的地址在 1 秒左右放弃', async () => {
    const silent = await serve(() => {});
    const started = Date.now();
    expect(await probeOllama(silent)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe('create-aalis --yes', () => {
  let dir: string;
  const servers: Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    await rm(dir, { recursive: true, force: true });
  });
  async function serve(handler: RequestListener): Promise<number> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('未监听 TCP');
    return address.port;
  }

  /** 真 CLI 跑一遍 --yes，返回生成的依赖、配置与终端输出 */
  async function create(ollamaHostValue: string) {
    dir = await mkdtemp(join(tmpdir(), 'aalis-yes-'));
    const registry = await serve((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(request.url?.startsWith('/-/v1/search') ? { objects: [] } : { version: '0.17.0' }));
    });
    const { stdout } = await run(
      process.execPath,
      ['--import', tsx, cli, 'my-bot', '--yes', '--no-install', '--registry', `http://127.0.0.1:${registry}`],
      { cwd: dir, timeout: 10_000, env: { ...process.env, OLLAMA_HOST: ollamaHostValue } },
    );
    const pkg = JSON.parse(await readFile(join(dir, 'my-bot', 'package.json'), 'utf-8'));
    const config = parse(await readFile(join(dir, 'my-bot', 'home', 'aalis.config.yaml'), 'utf-8'));
    return { deps: Object.keys(pkg.dependencies), config, stdout };
  }

  it('没探到 Ollama：对话模型是 DeepSeek，不装语义记忆，配置里留它的 apiKey', async () => {
    // 没人监听的端口：不碰本机真的 Ollama
    const { deps, config } = await create('127.0.0.1:9');
    expect(deps).toContain(DEEPSEEK);
    expect(deps).not.toContain(OLLAMA);
    expect(deps).not.toContain('@aalis/plugin-memory-vector');
    expect(deps).not.toContain('@aalis/plugin-websearch-serper');
    expect(config.plugins[DEEPSEEK]).toEqual({ apiKey: '' });
  });

  it('探到 Ollama：对话模型与语义记忆都用它，OLLAMA_HOST 写进两个 Ollama 插件的 baseUrl', async () => {
    const port = await serve((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ models: [{ name: 'qwen3:8b' }] }));
    });
    const { deps, config, stdout } = await create(`127.0.0.1:${port}`);
    expect(stdout).toContain('探到 Ollama');
    for (const name of [OLLAMA, OLLAMA_EMBEDDING, '@aalis/plugin-memory-vector', FLAT]) expect(deps).toContain(name);
    expect(deps).not.toContain(DEEPSEEK);
    expect(config.plugins[OLLAMA]).toEqual({ baseUrl: `http://127.0.0.1:${port}` });
    expect(config.plugins[OLLAMA_EMBEDDING]).toEqual({ baseUrl: `http://127.0.0.1:${port}` });
  });
  it('探到的 Ollama 里只有嵌入模型：写明先拉一个对话模型，「下一步」里有 ollama pull', async () => {
    const port = await serve((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify(
          request.url === '/api/tags'
            ? { models: [{ name: 'nomic-embed-text:latest' }] }
            : { capabilities: ['embedding'] },
        ),
      );
    });
    const { stdout } = await create(`127.0.0.1:${port}`);
    expect(stdout).toContain('里面还没有对话模型，启动前先 ollama pull 一个对话模型');
    expect(stdout).toContain('ollama pull <对话模型名>');
  });
});

describe('提问时按 Ctrl+C', () => {
  let dir: string;
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('说一句已取消，退出码 130，不打堆栈、不生成文件', async () => {
    dir = await mkdtemp(join(tmpdir(), 'aalis-cancel-'));
    // 预加载把 stdin 标成终端：提问照终端模式读键，Ctrl+C 经管道送进去
    const preload = join(dir, 'tty.mjs');
    await writeFile(preload, "Object.defineProperty(process.stdin, 'isTTY', { value: true });\n");
    const child = spawn(process.execPath, ['--import', preload, '--import', tsx, cli, '--no-install'], {
      cwd: dir,
      env: { ...process.env, OLLAMA_HOST: '127.0.0.1:9' },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', chunk => {
      out += String(chunk);
      if (out.includes('项目目录名')) child.stdin.write('\x03');
    });
    child.stderr.on('data', chunk => {
      err += String(chunk);
    });
    const code = await new Promise(resolve => child.on('close', resolve));
    expect(code).toBe(130);
    expect(err).toContain('已取消');
    expect(err).not.toContain('AbortError');
    expect(await readdir(dir)).toEqual(['tty.mjs']);
  });
});
