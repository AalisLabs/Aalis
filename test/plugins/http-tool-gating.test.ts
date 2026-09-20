import { describe, expect, it } from 'vitest';
import type { RegisteredTool } from '../../packages/api-tools/src/index.js';
import { registerHttpTools } from '../../packages/plugin-tool-system/src/tools/http.js';
import { stubBoundTools } from '../fixtures/bound-tools.js';

// ════════════════════════════════════════════════════════════
// http_download 写工具必须挂闸（restricted + confirm），
//     防被注入的 LLM 静默/越权写 storage（如覆写 data:/users.json）。
// ════════════════════════════════════════════════════════════

function captureRegistered(): Record<string, Omit<RegisteredTool, 'pluginName'>> {
  const tools: Record<string, Omit<RegisteredTool, 'pluginName'>> = {};
  const svc = stubBoundTools({
    onRegister: t => {
      tools[t.definition.function.name] = t;
    },
  });
  registerHttpTools(svc, { defaultTimeout: 30000, maxResponseSize: 1048576 });
  return tools;
}

describe('http 工具能力闸', () => {
  it('http_download：受限 + 每次确认', () => {
    const t = captureRegistered().http_download;
    expect(t).toBeDefined();
    expect(t.visibility).toBe('restricted');
    expect(t.confirm).toBe('session');
  });

  it('http_request：保持默认（暂未改其闸）', () => {
    const t = captureRegistered().http_request;
    expect(t).toBeDefined();
    expect(t.visibility).toBeUndefined(); // 默认 public，本批未动
  });
});
