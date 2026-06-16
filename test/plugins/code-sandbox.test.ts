import { describe, expect, it } from 'vitest';
import type { SandboxPolicy } from '../../packages/plugin-code-sandbox-api/src/index.js';
import {
  buildBwrapArgs,
  buildSeatbeltArgs,
  buildSeatbeltProfile,
  wrapForSandbox,
} from '../../packages/plugin-code-sandbox-os/src/sandbox.js';

// ════════════════════════════════════════════════════════════
// code-sandbox-os — OS 沙箱命令改写（纯函数；后端探测是功能性试跑，属集成、不在此测）
// ════════════════════════════════════════════════════════════

const POLICY: SandboxPolicy = { fsRead: ['/ws'], fsWrite: ['/ws', '/tmp/run-1'], network: 'deny' };
const ENV = { PATH: '/usr/bin', LANG: 'C', SECRET: undefined };

describe('buildSeatbeltProfile (SBPL)', () => {
  it('默认拒绝 + 读放开 + 写仅 fsWrite + 断网', () => {
    const p = buildSeatbeltProfile(POLICY);
    expect(p).toContain('(deny default)');
    expect(p).toContain('(allow file-read*)');
    expect(p).toContain('(allow file-write* (subpath "/ws"))');
    expect(p).toContain('(allow file-write* (subpath "/tmp/run-1"))');
    expect(p).toContain('(deny network*)');
    expect(p).not.toContain('(allow network*)');
  });
  it('network=allow → 放开网络', () => {
    expect(buildSeatbeltProfile({ ...POLICY, network: 'allow' })).toContain('(allow network*)');
  });
});

describe('buildSeatbeltArgs', () => {
  it('sandbox-exec -p <profile> env -i <白名单> cmd args；undefined env 被剔除', () => {
    const w = buildSeatbeltArgs(POLICY, 'python3', ['s.py'], ENV);
    expect(w.cmd).toBe('sandbox-exec');
    expect(w.args[0]).toBe('-p');
    const i = w.args.indexOf('env');
    expect(w.args[i + 1]).toBe('-i');
    expect(w.args).toContain('PATH=/usr/bin');
    expect(w.args).toContain('LANG=C');
    expect(w.args.some(a => a.startsWith('SECRET'))).toBe(false); // undefined 不进
    expect(w.args.slice(-2)).toEqual(['python3', 's.py']); // cmd + args 在末尾
  });
});

describe('buildBwrapArgs', () => {
  it('只读绑根 + 隔离全部(含 net) + 清 env 仅白名单 + rw 绑 fsWrite + chdir + 末尾 cmd', () => {
    const w = buildBwrapArgs(POLICY, 'python3', ['s.py'], '/ws', ENV);
    expect(w.cmd).toBe('bwrap');
    expect(w.args).toContain('--ro-bind');
    expect(w.args).toContain('--unshare-all');
    expect(w.args).toContain('--clearenv');
    expect(w.args).toContain('--die-with-parent');
    // env 白名单经 --setenv 注入；undefined 剔除
    expect(w.args.join(' ')).toContain('--setenv PATH /usr/bin');
    expect(w.args.join(' ')).toContain('--setenv LANG C');
    expect(w.args.join(' ')).not.toContain('SECRET');
    // rw 绑定写白名单
    expect(w.args.join(' ')).toContain('--bind /ws /ws');
    expect(w.args.join(' ')).toContain('--bind /tmp/run-1 /tmp/run-1');
    // deny 网络 → 不加 --share-net
    expect(w.args).not.toContain('--share-net');
    expect(w.args).toContain('--chdir');
    // 分隔符后是 cmd + args
    const sep = w.args.indexOf('--');
    expect(w.args.slice(sep + 1)).toEqual(['python3', 's.py']);
  });
  it('network=allow → 加 --share-net', () => {
    expect(buildBwrapArgs({ ...POLICY, network: 'allow' }, 'node', [], undefined, {}).args).toContain('--share-net');
  });
});

describe('wrapForSandbox', () => {
  it('按后端分派', () => {
    expect(wrapForSandbox('seatbelt', POLICY, 'python3', ['s.py'], '/ws', ENV).cmd).toBe('sandbox-exec');
    expect(wrapForSandbox('bwrap', POLICY, 'python3', ['s.py'], '/ws', ENV).cmd).toBe('bwrap');
  });
  it('none 抛错（调用方应先 fail-closed）', () => {
    expect(() => wrapForSandbox('none', POLICY, 'python3', [], undefined, {})).toThrow();
  });
});
