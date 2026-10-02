import { describe, expect, it } from 'vitest';
import {
  CLIENT_SWITCH_SCRIPT,
  renderClientSwitchPage,
} from '../../packages/plugin-webui-server/src/client-switch-page.js';

// ════════════════════════════════════════════════════════════
// 前端切换「逃生页」：webui-server 直出的恢复页，独立于任何可被切换的前端。
// 页面与脚本分开给出（文档级 CSP 只许同源脚本）——这里锁定它的「契约」：复用既有接口、不自造切换逻辑、切换前校验 res.ok。
// 若将来重命名 /api/services 或 .../prefer 接口，本测试会提醒同步更新本页。
// ════════════════════════════════════════════════════════════

const html = renderClientSwitchPage();

describe('renderClientSwitchPage', () => {
  it('是一份完整的 HTML 文档', () => {
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('</html>');
  });

  it('含前端选择下拉框与切换按钮；脚本是同源的外部文件，不内联', () => {
    expect(html).toContain('<select id="client"');
    expect(html).toContain('id="go"');
    expect(html).toContain('<script src="/__clients.js"></script>');
    expect(html).not.toMatch(/<script>/);
  });

  it('复用既有服务接口，不自造切换逻辑', () => {
    expect(CLIENT_SWITCH_SCRIPT).toContain('/api/services');
    expect(CLIENT_SWITCH_SCRIPT).toContain("'webui-client'");
    expect(CLIENT_SWITCH_SCRIPT).toContain('/prefer');
    expect(CLIENT_SWITCH_SCRIPT).toContain("method: 'POST'");
  });

  it('切换前校验 res.ok（避免非 owner 假成功后误刷新）', () => {
    expect(CLIENT_SWITCH_SCRIPT).toContain('r.ok');
    expect(CLIENT_SWITCH_SCRIPT).toContain("location.href = '/'");
  });

  it('401/403 时提示需要 owner 权限', () => {
    expect(CLIENT_SWITCH_SCRIPT).toContain('owner');
  });

  it('无可用前端时给出明确提示而非空白', () => {
    expect(CLIENT_SWITCH_SCRIPT).toContain('未发现任何前端');
  });
});
