import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFsYamlConfigProvider } from '../../packages/runtime/src/providers.js';

// ════════════════════════════════════════════════════════════
// 配置落盘此前是 writeFileSync 原地覆盖（O_CREAT|O_TRUNC）：写中断时截断已经发生、写入没完成，
// 盘上留 0 字节或半截 YAML。而空文件会被 loadFromDisk 当成「空配置」放行，随后 config-sync
// 按 schema 回填再存盘——没有 default 的 apiKey 就此永久消失。同仓 storage-local 早已为同样
// 理由做 tmp+rename，这条是漏掉的。
//
// 权限位是本修复自身的风险点：rename 会让目标继承 tmp 的 mode，用户 chmod 600 过的配置
// （里面是密钥）不能因一次保存退回 0644。
//
// 临时文件建出来就要是收紧的权限（沿用原文件的权限位，没有原文件时 0600）：先按默认 umask 建、
// 再 chmod 的话，其间或进程在 rename 前被杀时，目录里就有一份权限更宽的密钥副本。
//
// 写临时文件或改名失败时临时文件要删掉：它是整份配置（含密钥），不能留在配置目录里。
// ════════════════════════════════════════════════════════════

// 写满磁盘与改名失败在测试机上造不出来：只在打开开关时让它们失败，其余用例走真实实现。
// `tmp` 记下出错时临时文件的路径，用来确认失败发生在临时文件已经建出之后。
const fsFault = vi.hoisted(() => ({ write: false, rename: false, tmp: '' }));
// 临时文件刚写完、还没来得及 chmod 时的权限位：看的是建出那一刻的实况，不是最终结果
const tmpCreated = vi.hoisted(() => ({ mode: -1 }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      const [file, data] = args;
      if (fsFault.write && String(file).includes('.tmp.')) {
        // 写到一半磁盘满：临时文件已建出，只有半截内容
        fs.writeFileSync(file, String(data).slice(0, 8));
        fsFault.tmp = String(file);
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      }
      fs.writeFileSync(...args);
      if (String(file).includes('.tmp.')) tmpCreated.mode = fs.statSync(String(file)).mode & 0o777;
    },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (fsFault.rename) {
        fsFault.tmp = String(args[0]);
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      }
      return fs.renameSync(...args);
    },
  };
});

let dir: string;
let cfgPath: string;

/**
 * `ConfigProvider.save` 在契约上是可选的（纯内存 provider 可以不提供）。这里显式收窄并在
 * 缺失时立刻抛——用 `?.` 静默跳过会让下面每个用例都退化成恒真，正好把要守的东西守没了。
 */
function save(provider: { save?: (config: never) => void | Promise<void> }, config: object): void {
  if (!provider.save) throw new Error('createFsYamlConfigProvider 必须提供 save');
  provider.save(config as never);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aalis-cfg-atomic-'));
  cfgPath = join(dir, 'aalis.config.yaml');
});
afterEach(() => {
  Object.assign(fsFault, { write: false, rename: false, tmp: '' });
  tmpCreated.mode = -1;
  rmSync(dir, { recursive: true, force: true });
});

describe('配置文件原子写', () => {
  it('保存后不残留临时文件，内容可回读', () => {
    writeFileSync(cfgPath, 'name: Aalis\nlogLevel: info\nplugins: {}\n', 'utf-8');
    const { provider } = createFsYamlConfigProvider(cfgPath);
    save(provider, { name: 'Aalis', logLevel: 'debug', plugins: {} });

    expect(existsSync(cfgPath)).toBe(true);
    expect(readFileSync(cfgPath, 'utf-8')).toContain('logLevel: debug');
    expect(
      readdirSync(dir).filter(f => f.includes('.tmp.')),
      '临时文件必须被 rename 掉，不能留在配置目录里',
    ).toEqual([]);
  });

  it('是原子替换而非原地截断——inode 必须变', () => {
    writeFileSync(cfgPath, 'name: Aalis\nplugins: {}\n', 'utf-8');
    const before = statSync(cfgPath).ino;

    const { provider } = createFsYamlConfigProvider(cfgPath);
    save(provider, { name: 'Aalis', logLevel: 'info', plugins: {} });

    // writeFileSync 原地覆盖走 O_CREAT|O_TRUNC，inode 不变——截断先发生、写入后失败时
    // 盘上就留下 0 字节或半截 YAML。tmp+rename 则是换 inode 的原子替换，不存在中间态。
    expect(statSync(cfgPath).ino, '原地截断会保留 inode，说明写不是原子的').not.toBe(before);
  });

  it('沿用原文件权限位——配置里是密钥，不能因一次保存从 600 退回 644', () => {
    writeFileSync(cfgPath, 'name: Aalis\nplugins: {}\n', { encoding: 'utf-8', mode: 0o600 });
    const before = statSync(cfgPath).mode & 0o777;
    expect(before).toBe(0o600);

    const { provider } = createFsYamlConfigProvider(cfgPath);
    save(provider, { name: 'Aalis', logLevel: 'info', plugins: {} });

    expect(statSync(cfgPath).mode & 0o777, 'rename 让目标继承 tmp 的 mode——必须先 chmod tmp').toBe(before);
  });

  it('文件原本不存在时也能创建', () => {
    const { provider } = createFsYamlConfigProvider(cfgPath);
    save(provider, { name: 'Aalis', logLevel: 'info', plugins: {} });
    expect(existsSync(cfgPath)).toBe(true);
    expect(readdirSync(dir).filter(f => f.includes('.tmp.'))).toEqual([]);
  });
});

describe('临时文件建出时即是收紧的权限', () => {
  /** 固定 umask 跑一段：默认 umask 因机器而异，0077 的机器上旧写法也会建出 0600，用例就守不住 */
  function withUmask(mask: number, fn: () => void): void {
    const prev = process.umask(mask);
    try {
      fn();
    } finally {
      process.umask(prev);
    }
  }

  it('原文件是 600：临时文件建出那一刻就是 600，不先以 644 存在', () => {
    writeFileSync(cfgPath, 'name: Aalis\nplugins: {}\n', { encoding: 'utf-8', mode: 0o600 });
    const { provider } = createFsYamlConfigProvider(cfgPath);
    withUmask(0o022, () => save(provider, { name: 'Aalis', logLevel: 'info', plugins: {} }));

    expect(tmpCreated.mode, '按默认 umask 建出的临时文件是 644，含密钥').toBe(0o600);
    expect(statSync(cfgPath).mode & 0o777).toBe(0o600);
  });

  it('原文件不存在：按 600 建，保存出来的配置文件也是 600', () => {
    const { provider } = createFsYamlConfigProvider(cfgPath);
    withUmask(0o022, () => save(provider, { name: 'Aalis', logLevel: 'info', plugins: {} }));

    expect(tmpCreated.mode).toBe(0o600);
    expect(statSync(cfgPath).mode & 0o777).toBe(0o600);
  });

  it('umask 比原文件权限更严：建出时更窄，改名前仍对齐回原文件的权限位', () => {
    writeFileSync(cfgPath, 'name: Aalis\nplugins: {}\n', 'utf-8');
    chmodSync(cfgPath, 0o640);
    const { provider } = createFsYamlConfigProvider(cfgPath);
    withUmask(0o077, () => save(provider, { name: 'Aalis', logLevel: 'info', plugins: {} }));

    expect(tmpCreated.mode, '建出时受 umask 收窄').toBe(0o600);
    expect(statSync(cfgPath).mode & 0o777, '保存不改变用户设定的权限位').toBe(0o640);
  });
});

describe('写入或改名失败时删掉临时文件', () => {
  it.each([
    ['写临时文件写到一半失败（磁盘写满）', 'write', /ENOSPC/],
    ['改名失败', 'rename', /EPERM/],
  ] as const)('%s：原错误照常抛出，目录里不留临时文件，原配置不动', (_label, fault, error) => {
    const original = 'name: Aalis\nlogLevel: info\nplugins: {}\n';
    writeFileSync(cfgPath, original, 'utf-8');
    const { provider } = createFsYamlConfigProvider(cfgPath);

    fsFault[fault] = true;
    expect(() => save(provider, { name: 'Aalis', logLevel: 'debug', plugins: {} })).toThrow(error);
    fsFault[fault] = false;

    expect(fsFault.tmp, '前置：失败发生在临时文件建出之后').toContain('.tmp.');
    expect(existsSync(fsFault.tmp), '含密钥的临时文件必须删掉').toBe(false);
    expect(readdirSync(dir).filter(f => f.includes('.tmp.'))).toEqual([]);
    expect(readFileSync(cfgPath, 'utf-8')).toBe(original);
  });
});
