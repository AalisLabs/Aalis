import { describe, expect, it } from 'vitest';
import { buildPrompt } from '../../packages/plugin-paper/src/prompt.js';

const base = {
  layout: {
    workDir: '/agent',
    outDir: '/opt/out',
    bundlePath: '/opt/workspace.tar.gz',
    policyNotes: ['保留原有工程'],
  },
  taskId: 't-123',
  text: '做一个网页作品',
  maxRunMinutes: 20,
};

describe('待发布任务前言', () => {
  it('视觉风格服从本次需求，未指定的设计留给创作代理，兼容用户明确的单文件要求', () => {
    const request = '请做一个黑白报纸排版的个人页，必须单个 HTML 文件';
    const prompt = buildPrompt({ ...base, text: request, publication: true });
    expect(prompt).toContain(request);
    expect(prompt).toContain('视觉风格和布局按本次需求设计');
    expect(prompt).toContain('未指定的部分由你设计');
    expect(prompt).not.toContain('群友');
    expect(prompt).not.toContain('蓝白');
    expect(prompt).not.toContain('圆角卡片');
  });

  it('只让最终可部署文件进入成品目录，完整工程留在工程包，不指示远端自行发布', () => {
    const prompt = buildPrompt({ ...base, publication: true });
    expect(prompt).toContain('/opt/out/t-123/');
    expect(prompt).toContain('index.html');
    expect(prompt).toContain('相对路径');
    expect(prompt).toContain('最终');
    expect(prompt).toContain('/opt/workspace.tar.gz');
    expect(prompt).toMatch(/预览|报告|源码包/);
    expect(prompt).toContain('不在外部平台部署或公开发布');
    expect(prompt).not.toContain('预览不是必需品');
    expect(prompt).toContain('尽早把第一版可用成品写入 /opt/out/t-123/');
  });

  it('普通任务先交第一版，预览与字体处理不阻断成品', () => {
    const prompt = buildPrompt(base);
    expect(prompt).toContain('在 /agent 维护工程文件');
    expect(prompt).toContain('这一轮总时长上限为 20 分钟');
    expect(prompt).toContain('先保存主要工程文件');
    expect(prompt).toContain('尽早把第一版可用成品写入 /opt/out/t-123/');
    expect(prompt).toContain('预览不是必需品');
    expect(prompt).toContain('预览失败不阻断成品交付');
    expect(prompt).toContain('不要为了截图安装环境');
    expect(prompt).toContain('系统字体');
    expect(prompt).toContain('不要只在最后打包');
    expect(prompt).toContain('先写临时包，再替换原包');
    expect(prompt).not.toContain('只在 /agent 里工作');
    expect(prompt).not.toContain('另附一份预览');
  });
});
