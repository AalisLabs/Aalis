import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { RegisteredTool } from '../../packages/api-tools/src/index.js';
import { DocSessionManager } from '../../packages/plugin-office/src/session.js';
import { registerDocxTools } from '../../packages/plugin-office/src/tools/docx.js';
import { stubBoundTools } from '../fixtures/bound-tools.js';

// ════════════════════════════════════════════════════════════
// doc_set_header_footer 的 showPageNumber：页脚写入 PAGE 域；
// 与页脚文字同在时以分隔符隔开。
// ════════════════════════════════════════════════════════════

/** 从 zip 里取出文件名匹配的条目文本（经中央目录定位，只处理 store / deflate 两种压缩方式） */
function readZipEntries(zip: Buffer, match: RegExp): string[] {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    if (match.test(name)) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const raw = zip.subarray(start, start + size);
      out.push((method === 8 ? inflateRawSync(raw) : raw).toString('utf8'));
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function saveWithFooter(meta: Record<string, unknown>): Promise<string> {
  const tools: Record<string, Omit<RegisteredTool, 'pluginName'>> = {};
  let written: Buffer | undefined;
  const storage = {
    writeFile: async (_uri: string, data: Buffer) => {
      written = data;
    },
  };
  registerDocxTools(
    stubBoundTools({
      onRegister: t => {
        tools[t.definition.function.name] = t;
      },
    }),
    new DocSessionManager(),
    storage as never,
    'workspace:/',
  );
  const ctx = { sessionId: 's', enabledGroups: undefined };
  const { docId } = JSON.parse((await tools.doc_create.handler({ filename: 'a.docx' }, ctx)) as string);
  await tools.doc_add_paragraph.handler({ docId, text: '正文' }, ctx);
  await tools.doc_set_header_footer.handler({ docId, ...meta }, ctx);
  await tools.doc_save.handler({ docId }, ctx);
  if (!written) throw new Error('doc_save 未写盘');
  const footers = readZipEntries(written, /^word\/footer\d*\.xml$/);
  expect(footers).toHaveLength(1);
  return footers[0];
}

describe('doc_set_header_footer 页码', () => {
  it('只开 showPageNumber：页脚写入 PAGE 域', async () => {
    const xml = await saveWithFooter({ showPageNumber: true });
    expect(xml).toMatch(/<w:instrText[^>]*>PAGE<\/w:instrText>/);
    expect(xml).not.toContain(' | ');
  });

  it('页脚文字与页码同在：文字、分隔符、PAGE 域依次出现', async () => {
    const xml = await saveWithFooter({ footer: '机密文件', showPageNumber: true });
    const text = xml.indexOf('机密文件');
    const sep = xml.indexOf(' | ');
    const page = xml.search(/<w:instrText[^>]*>PAGE<\/w:instrText>/);
    expect(text).toBeGreaterThan(-1);
    expect(sep).toBeGreaterThan(text);
    expect(page).toBeGreaterThan(sep);
  });

  it('不开 showPageNumber：页脚只有文字，没有页码域', async () => {
    const xml = await saveWithFooter({ footer: '机密文件' });
    expect(xml).toContain('机密文件');
    expect(xml).not.toContain('PAGE');
  });
});
