// ============================================================
// 前言：每轮交给远端代理的正文 = 宿主写的工作约束 + 群友的原文
//
// 约束来自提供者声明的工作区布局（layout）：工作目录、本件交付目录、工程包路径，再逐条附上提供者特有的
// 约束（policyNotes）。换新后新代理在第一轮成功之前，另加一句取得旧工程包（提供者给的链接或路径）并解开。
// 前言不含任何凭据。
// ============================================================

import type { WorkspaceLayout } from '@aalis/api-remote-agent';

export function buildPrompt(p: { layout: WorkspaceLayout; taskId: string; text: string; bundleUrl?: string }): string {
  const { layout } = p;
  const outDir = `${layout.outDir.replace(/\/+$/, '')}/${p.taskId}/`;
  const rules = [
    `只在 ${layout.workDir} 里工作。`,
    ...(p.bundleUrl ? [`开始前先取得工程包 ${p.bundleUrl}，解开到 ${layout.workDir}。`] : []),
    `本件成品放进 ${outDir}；网页作品尽量做成单个自包含的 index.html，另附一份预览（PNG、GIF 或 MP4）。`,
    `这一轮结束前，把完整工程（不含 node_modules 这类依赖目录）打包成 ${layout.bundlePath}。`,
    '不设定时唤醒；不做扫描、刷量、注册账号；不在外部平台部署或公开发布。',
    ...layout.policyNotes,
  ];
  return [
    '你在一个长期工作区里替群友完成任务。规则：',
    ...rules.map(rule => `- ${rule}`),
    '',
    `任务 ${p.taskId}，以下是群友的原文：`,
    p.text,
  ].join('\n');
}
