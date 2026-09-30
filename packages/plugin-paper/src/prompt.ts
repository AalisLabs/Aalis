// ============================================================
// 前言：每轮交给远端代理的正文 = 宿主写的工作约束 + 本次创作需求
//
// 约束来自提供者声明的工作区布局（layout）：工作目录、本件交付目录、工程包路径，再逐条附上提供者特有的
// 约束（policyNotes）。换新后新代理在第一轮成功之前，另加一句取得旧工程包（提供者给的链接或路径）并解开。
// 前言不含任何凭据。
// ============================================================

import type { WorkspaceLayout } from '@aalis/api-remote-agent';

export function buildPrompt(p: {
  layout: WorkspaceLayout;
  taskId: string;
  text: string;
  maxRunMinutes: number;
  bundleUrl?: string;
  publication?: boolean;
}): string {
  const { layout } = p;
  const outDir = `${layout.outDir.replace(/\/+$/, '')}/${p.taskId}/`;
  const rules = [
    `在 ${layout.workDir} 维护工程文件；${outDir} 用于交付本件成品，${layout.bundlePath} 用于保存工程包。`,
    '视觉风格和布局按本次需求设计；未指定的部分由你设计，不因同一工作区已有作品就沿用相同排版。遵守用户明确提出的风格和交付格式。',
    ...(p.bundleUrl ? [`开始前先取得工程包 ${p.bundleUrl}，解开到 ${layout.workDir}。`] : []),
    `这一轮总时长上限为 ${p.maxRunMinutes} 分钟，从远端开轮开始计算，到点宿主会请求取消。先保存主要工程文件，尽早把第一版可用成品写入 ${outDir}；有余时再完善并更新成品。`,
    p.publication
      ? `本件成品放进 ${outDir}；这里只放最终可部署的作品文件。网页作品以根目录 index.html 为入口，CSS、脚本、图片等引用资源放在同一成品目录内并使用相对路径；单文件媒体只放最终媒体文件。不要混入预览、报告、源码包、工程归档或无关文件。`
      : `本件成品放进 ${outDir}；网页交付文件时优先做成可直接打开的自包含 HTML，单页优先使用系统字体，避免为字体下载和裁剪耽误交付。预览不是必需品：仅在用户明确需要或现成环境可直接生成时，完成可用成品后再做。预览失败不阻断成品交付，不要为了截图安装环境。`,
    `保存第一版工程后就把完整工程（不含 node_modules 这类依赖目录）打包成 ${layout.bundlePath}，重要修改后更新，结束前再更新一次；不要只在最后打包，以便中断后继续制作。先写临时包，再替换原包，保留最近一次完整工程。`,
    '不设定时唤醒；不做扫描、刷量、注册账号；不在外部平台部署或公开发布。',
    ...layout.policyNotes,
  ];
  return [
    '你在一个长期工作区里替用户完成任务。规则：',
    ...rules.map(rule => `- ${rule}`),
    '',
    `任务 ${p.taskId}，本次创作需求：`,
    p.text,
  ].join('\n');
}
