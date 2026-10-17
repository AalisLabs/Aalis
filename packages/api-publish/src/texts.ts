// 本包自己的原文字典：公开路径不能上站的原因（只写类别，不带参数）
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  pathEmpty: '路径为空',
  pathTooLong: '路径过长',
  pathSlashEnds: '路径以斜杠开头或结尾',
  pathTooDeep: '路径层级过多',
  pathReservedName: '路径含保留的文件名',
  pathReservedDir: '路径占用了保留的目录名',
  pathBadCharacters: '路径段含不允许的字符',
  extensionNotAllowed: '扩展名不在白名单',
  htmlNotIndex: '网页文件只能是作品根目录的 index.html',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/api-publish', language: 'zh-CN', source: SOURCE, locales: { en } });
