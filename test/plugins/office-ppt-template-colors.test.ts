import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RegisteredTool } from '../../packages/api-tools/src/index.js';
import { DocSessionManager } from '../../packages/plugin-office/src/session.js';
import { registerPptTools } from '../../packages/plugin-office/src/tools/pptx.js';
import { stubBoundTools } from '../fixtures/bound-tools.js';

// ════════════════════════════════════════════════════════════
// PPT 预设模板的母版文字必须与所在底色不同：
// 写在主色/辅色底上的标题与结束页文字用 colors.title，dark 预设不再同色叠字。
// ════════════════════════════════════════════════════════════

/** 各预设的 colors.title（模板表未导出，按源码抄录） */
const TITLE_COLORS: Record<string, string> = {
  clean: 'FFFFFF',
  dark: 'FFFFFF',
  corporate: 'FFFFFF',
  minimal: 'FFFFFF',
  nature: 'FFFFFF',
  warm: 'FFFFFF',
};
const TEMPLATES = Object.keys(TITLE_COLORS);

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface MasterProps {
  title: string;
  background: { color: string };
  objects: Array<{
    rect?: Box & { fill: { color: string } };
    text?: { text: string; options: Box & { color: string; placeholder?: string } };
  }>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** 用指定模板创建演示文稿，返回登记到 pptx 实例上的母版参数 */
async function mastersOf(template: string): Promise<MasterProps[]> {
  const tools: Record<string, Omit<RegisteredTool, 'pluginName'>> = {};
  const sessions = new DocSessionManager();
  registerPptTools(
    stubBoundTools({
      onRegister: t => {
        tools[t.definition.function.name] = t;
      },
    }),
    sessions,
    {} as never,
    'workspace:/',
  );
  const ctx = { sessionId: 's', enabledGroups: undefined };
  // 先建一份不带模板的文稿拿到 pptxgenjs 原型，再在原型上记录母版定义
  const probe = JSON.parse((await tools.ppt_create.handler({ filename: 'probe.pptx' }, ctx)) as string);
  const proto = Object.getPrototypeOf((sessions.require(probe.docId).doc as { pptx: object }).pptx);
  const spy = vi.spyOn(proto, 'defineSlideMaster');
  await tools.ppt_create.handler({ filename: 'a.pptx', template }, ctx);
  return spy.mock.calls.map(call => call[0] as MasterProps);
}

/** 文字框左上角落在哪块底色上：落在某个矩形内取矩形填充色，否则取母版背景色 */
function backdropOf(master: MasterProps, box: Box): string {
  for (const o of master.objects) {
    const r = o.rect;
    if (r && box.x >= r.x && box.x < r.x + r.w && box.y >= r.y && box.y < r.y + r.h) return r.fill.color;
  }
  return master.background.color;
}

describe('PPT 预设模板母版配色', () => {
  it.each(TEMPLATES)('%s：母版上每段文字与所在底色不同', async template => {
    const masters = await mastersOf(template);
    expect(masters.map(m => m.title)).toEqual(['title', 'content', 'section', 'end']);
    for (const master of masters) {
      for (const o of master.objects) {
        if (!o.text) continue;
        const label = `${template}/${master.title}/${o.text.options.placeholder ?? o.text.text}`;
        expect(o.text.options.color, label).not.toBe(backdropOf(master, o.text.options));
      }
    }
  });

  it.each(TEMPLATES)('%s：各母版标题与结束页 Thank You 用该预设的 colors.title', async template => {
    const colored: string[] = [];
    for (const master of await mastersOf(template)) {
      for (const o of master.objects) {
        if (!o.text || (o.text.options.placeholder !== 'title' && o.text.text !== 'Thank You')) continue;
        colored.push(master.title);
        expect(o.text.options.color, `${template}/${master.title}`).toBe(TITLE_COLORS[template]);
      }
    }
    expect(colored).toEqual(['title', 'content', 'section', 'end']);
  });

  it('dark：结束页 Thank You 用白色写在深色底上', async () => {
    const end = (await mastersOf('dark')).find(m => m.title === 'end');
    const thanks = end?.objects.find(o => o.text?.text === 'Thank You');
    expect(thanks?.text?.options.color).toBe('FFFFFF');
    expect(end?.background.color).toBe('0D1117');
  });
});
