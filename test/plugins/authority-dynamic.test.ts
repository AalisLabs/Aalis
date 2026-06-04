import type { ConfigManager, Logger, StorageService } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { AuthorityManager } from '../../packages/plugin-authority/src/index.js';

function makeLogger(): Logger {
  const noop = () => undefined;
  const l = { debug: noop, info: noop, warn: noop, error: noop, child: () => l } as unknown as Logger;
  return l;
}

function makeManager(cfg: Record<string, unknown> = {}): AuthorityManager {
  const config = { get: (k: string) => cfg[k] } as unknown as ConfigManager;
  const storage = {} as unknown as StorageService;
  return new AuthorityManager(config, makeLogger(), storage);
}

// file_write/file_edit/file_delete 通过 storagePermission 产出的权限形态
function perms(uri: string, op: 'read' | 'write' | 'delete'): string[] {
  const root = uri.slice(0, uri.indexOf(':/'));
  return [`storage:${op}`, `storage:${root}:${op}`, `storage:path:${uri}:${op}`];
}

describe('authority — 参数级动态提权 requiredAuthorityFor', () => {
  it('写普通文件不提权（返回 0）', () => {
    const m = makeManager();
    expect(m.requiredAuthorityFor(perms('data:/notes/a.md', 'write'))).toBe(0);
    expect(m.requiredAuthorityFor(perms('workspace:/x.ts', 'write'))).toBe(0);
  });

  it('写/删用户权限表要求 owner 等级（默认 5）', () => {
    const m = makeManager();
    expect(m.requiredAuthorityFor(perms('data:/users.json', 'write'))).toBe(5);
    expect(m.requiredAuthorityFor(perms('data:/users.json', 'delete'))).toBe(5);
  });

  it('写/删计划任务文件要求 owner 等级（防注入 owner 身份 actor）', () => {
    const m = makeManager();
    expect(m.requiredAuthorityFor(perms('data:/scheduler-jobs.json', 'write'))).toBe(5);
    expect(m.requiredAuthorityFor(perms('data:/scheduler-jobs.json', 'delete'))).toBe(5);
  });

  it('读敏感文件默认不提权（只保护写/删）', () => {
    const m = makeManager();
    expect(m.requiredAuthorityFor(perms('data:/users.json', 'read'))).toBe(0);
  });

  it('保护等级跟随 ownerAuthority 配置', () => {
    const m = makeManager({ ownerAuthority: 7 });
    expect(m.requiredAuthorityFor(perms('data:/users.json', 'write'))).toBe(7);
  });

  it('config.permissionAuthority 可扩展保护清单', () => {
    const m = makeManager({ permissionAuthority: { 'storage:path:workspace:/secret.txt:write': 4 } });
    expect(m.requiredAuthorityFor(perms('workspace:/secret.txt', 'write'))).toBe(4);
    // 默认清单仍生效
    expect(m.requiredAuthorityFor(perms('data:/users.json', 'write'))).toBe(5);
  });

  it('config.permissionAuthority 可覆盖默认条目', () => {
    const m = makeManager({ permissionAuthority: { 'storage:path:data:/users.json:write': 3 } });
    expect(m.requiredAuthorityFor(perms('data:/users.json', 'write'))).toBe(3);
  });

  it('命中多个模式时取最大要求', () => {
    const m = makeManager({ permissionAuthority: { 'storage:data:write': 2 } });
    // 同时命中 storage:data:write(2) 与 users.json(5) → 取 5
    expect(m.requiredAuthorityFor(perms('data:/users.json', 'write'))).toBe(5);
  });

  it('空权限集返回 0', () => {
    const m = makeManager();
    expect(m.requiredAuthorityFor([])).toBe(0);
  });
});
