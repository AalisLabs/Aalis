import { describe, expect, it } from 'vitest';
import { renderClientSwitchPage } from '../../packages/plugin-webui-server/src/client-switch-page.js';

// ════════════════════════════════════════════════════════════
// 前端切换「逃生页」：webui-server 直出的恢复页，独立于任何可被切换的前端。
// 纯函数渲染——这里锁定它的「契约」：复用既有接口、不自造切换逻辑、切换前校验 res.ok。
// 若将来重命名 /api/services 或 .../prefer 接口，本测试会提醒同步更新本页。
// ════════════════════════════════════════════════════════════

const html = renderClientSwitchPage();

describe('renderClientSwitchPage', () => {
  it('是一份完整的 HTML 文档', () => {
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('</html>');
  });

  it('含前端选择下拉框与切换按钮', () => {
    expect(html).toContain('<select id="client"');
    expect(html).toContain('id="go"');
  });

  it('复用既有服务接口，不自造切换逻辑', () => {
    expect(html).toContain('/api/services');
    expect(html).toContain("'webui-client'");
    expect(html).toContain('/prefer');
    expect(html).toContain("method: 'POST'");
  });

  it('切换前校验 res.ok（避免非 owner 假成功后误刷新）', () => {
    expect(html).toContain('r.ok');
    expect(html).toContain("location.href = '/'");
  });

  it('401/403 时提示需要 owner 权限', () => {
    expect(html).toContain('owner');
  });

  it('无可用前端时给出明确提示而非空白', () => {
    expect(html).toContain('未发现任何前端');
  });
});
