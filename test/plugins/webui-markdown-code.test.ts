import { describe, expect, it } from 'vitest';
import { markdownCode } from '../../packages/api-webui/src/index.js';

// ════════════════════════════════════════════════════════════
// markdownCode：插件把 YAML、JSON 原文交给文字组件显示时用。原文里的反引号与 Markdown 记号不能把代码块提前收尾。
// ════════════════════════════════════════════════════════════

describe('markdownCode', () => {
  it('普通原文：三个反引号的围栏，带语言，末尾换行只留一个', () => {
    expect(markdownCode('id: a\nnodes: []\n', 'yaml')).toBe('```yaml\nid: a\nnodes: []\n```');
  });

  it('原文里有一串反引号：围栏比最长的那串多一个', () => {
    expect(markdownCode('说明 ```js\n# 标题\n``````', 'md')).toBe('```````md\n说明 ```js\n# 标题\n``````\n```````');
  });

  it('没有语言时围栏后面不跟字', () => {
    expect(markdownCode('{"a":1}')).toBe('```\n{"a":1}\n```');
  });
});
