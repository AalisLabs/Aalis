// 本插件自己的原文字典：显示名（同为工具分组名）与分组概述、配置项，/clear 的类型显示名与清理绘图产物的回执
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: '绘图',
  groupSummary: '把模型编写的 SVG/HTML 标记渲染为图片，配合 send_attachment 发进聊天',
  defaultWidthLabel: '默认画布宽 (px)',
  defaultWidthDescription: 'HTML 模式与未声明宽度的 SVG 使用的画布宽度',
  maxWidthLabel: '画布宽上限 (px)',
  maxWidthDescription: '请求宽与标记声明宽都会被收口到该值',
  maxPixelsLabel: '画布 CSS 像素上限',
  maxPixelsDescription:
    'width×height（CSS 像素）上限，默认 4MP。注意实际光栅内存 = 本值 × scale²（scale 默认 2 即 4 倍）；静态图按 scale 截图，故设备像素天花板是本值的 scale² 倍——调高前算好内存',
  maxSourceKBLabel: '输入标记上限 (KB)',
  maxSourceKBDescription: 'source 参数的大小上限',
  scaleLabel: '截图缩放倍率',
  scaleDescription: 'deviceScaleFactor：2 = 视网膜清晰度（像素翻倍，文件更大）',
  headlessLabel: '无头模式',
  headlessDescription: '调试时可关闭以观察渲染页面',
  executablePathLabel: 'Chrome 路径（留空自动探测）',
  executablePathDescription: '留空使用 puppeteer 缓存的 Chrome（与浏览器工具共用同一份二进制，进程独立）',
  sandboxLabel: 'Chromium 沙箱',
  sandboxDescription:
    '打开后 Chromium 带沙箱启动，所画标记即使攻破渲染进程也出不了沙箱。Linux 上以 root 运行或容器里没有可用的沙箱时，打开后 Chromium 无法启动。',
  idleShutdownSecLabel: '空闲关停（秒）',
  idleShutdownSecDescription: '渲染引擎空闲该时长后关停 Chromium 释放内存；0 = 常驻',
  maxConcurrencyLabel: '渲染并发上限',
  maxConcurrencyDescription: '同时进行的渲染任务数上限；群内多人并发画图时超出的排队，防无界 page + ffmpeg 拖垮机器',
  animMaxDurationSecLabel: '动图时长上限（秒）',
  animMaxDurationSecDescription: 'draw_animation 的动画时长硬上限',
  animDefaultFpsLabel: '动图默认帧率',
  animDefaultFpsDescription: '未显式指定 fps 时使用；上限 25',
  animMaxFramesLabel: '动图帧数上限',
  animMaxFramesDescription: '时长×帧率超出时按帧数反推有效时长',
  animMaxOutputMBLabel: 'GIF 体积上限 (MB)',
  animMaxOutputMBDescription: '超出即报错（OneBot 内联投递上限 10MB，留余量）',
  clearType: '图片缓存',
  cleared: '绘图产物已清空（{count, number} 个）',
  clearFailed: '绘图产物清空失败：{error}',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-draw', language: 'zh-CN', source: SOURCE, locales: { en } });
