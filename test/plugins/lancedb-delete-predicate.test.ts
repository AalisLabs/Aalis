import { describe, expect, it } from 'vitest';
import { metaJsonFieldPredicate } from '../../packages/plugin-vectorstore-lancedb/src/index.js';

// ════════════════════════════════════════════════════════════
// LanceDB 原生 delete 谓词：按 metadata_json 子串匹配。
//   回归「/clear 全表载入 OOM 硬崩」——改用原生 delete(谓词) 后，谓词的自定界/边界/转义须正确。
// ════════════════════════════════════════════════════════════

describe('metaJsonFieldPredicate', () => {
  it('字符串值自带引号 → 自定界，前缀扩展不误配', () => {
    const p = metaJsonFieldPredicate('sessionId', 'onebot:1:group:100');
    // 命中 "sessionId":"onebot:1:group:100" 后必须紧跟 , 或 } —— group:1000 不会被误配
    expect(p).toContain(`"sessionId":"onebot:1:group:100",`);
    expect(p).toContain(`"sessionId":"onebot:1:group:100"}`);
    expect(p).toContain('ESCAPE');
  });

  it('数字值靠尾随 ,/} 定界，前缀扩展不误配（17510 ≠ 175100）', () => {
    const p = metaJsonFieldPredicate('timestamp', 17510);
    expect(p).toContain('"timestamp":17510,');
    expect(p).toContain('"timestamp":17510}');
    // 不应出现无边界的裸子串（那会把 175100 也匹配上）
    expect(p).not.toMatch(/"timestamp":17510'/);
  });

  it('转义 SQL 单引号与 LIKE 通配符（防注入/误配）', () => {
    const p = metaJsonFieldPredicate('userId', "a'b%c_d\\e");
    expect(p).toContain("a''b"); // 单引号翻倍
    expect(p).toContain('\\%'); // % 被转义
    expect(p).toContain('\\_'); // _ 被转义
    expect(p).toContain('\\\\'); // 反斜杠被转义
  });
});
