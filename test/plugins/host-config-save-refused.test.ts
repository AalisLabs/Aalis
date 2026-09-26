import { describe, expect, it } from 'vitest';
import { ConfigSaveRefusedError, isConfigSaveRefused } from '../../packages/api-host-config/src/index.js';

// ════════════════════════════════════════════════════════════
// 宿主拒写判据：save() 的拒绝是「盘上有尚未生效的外部修改、宿主为免覆盖而拒写」，还是写入失败。
// 宿主（runtime）与消费方（WebUI 等）各自依赖 @aalis/api-host-config，进程里可能装有两份：
// 宿主抛出的是它那份的类，消费方拿自己那份做 instanceof 就判不出来，拒写被当成写入失败。
// 契约：按 name 判定，两份都认得。
// ════════════════════════════════════════════════════════════

/** 进程里另一份 @aalis/api-host-config 的拒写类：类身份不同，名字相同 */
class ForeignCopyRefusedError extends Error {
  override name = 'ConfigSaveRefusedError';
}

describe('isConfigSaveRefused', () => {
  it('本包的拒写类与另一份副本的同名类都认作拒写', () => {
    expect(isConfigSaveRefused(new ConfigSaveRefusedError('x'))).toBe(true);
    const foreign = new ForeignCopyRefusedError('x');
    expect(foreign instanceof ConfigSaveRefusedError, '前置：两份的类身份不同').toBe(false);
    expect(isConfigSaveRefused(foreign)).toBe(true);
  });

  it('写入失败等其它拒绝不算拒写，文案里带类名也不算', () => {
    expect(isConfigSaveRefused(new Error('ConfigSaveRefusedError'))).toBe(false);
    expect(isConfigSaveRefused(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))).toBe(false);
    expect(isConfigSaveRefused('ConfigSaveRefusedError')).toBe(false);
    expect(isConfigSaveRefused(null)).toBe(false);
    expect(isConfigSaveRefused(undefined)).toBe(false);
  });
});
