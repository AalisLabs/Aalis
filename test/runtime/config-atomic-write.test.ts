import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFsYamlConfigProvider } from '../../packages/runtime/src/providers.js';

// ════════════════════════════════════════════════════════════
// 配置落盘此前是 writeFileSync 原地覆盖（O_CREAT|O_TRUNC）：写中断时截断已经发生、写入没完成，
// 盘上留 0 字节或半截 YAML。而空文件会被 loadFromDisk 当成「空配置」放行，随后 config-sync
// 按 schema 回填再存盘——没有 default 的 apiKey 就此永久消失。同仓 storage-local 早已为同样
// 理由做 tmp+rename，这条是漏掉的。
//
// 权限位是本修复自身的风险点：rename 会让目标继承 tmp 的 mode，用户 chmod 600 过的配置
// （里面是密钥）不能因一次保存退回 0644。
// ════════════════════════════════════════════════════════════

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
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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
