// 本插件自己的原文字典：显示名、服务标签与配置项，存储操作的报错（两用：工具结果取原文给模型，经回滚、删文件等给人看），诊断项
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: '本地存储根（命名 + 路径解析）',
  provideLabel: '本地存储',
  rootsLabel: '存储根目录',
  rootsDescription:
    '文件工具与 agent 寻址用的根（缺省只有 workspace）；插件自己的数据在内置根里（data、pluginData、tmp、cache、logs、personas、skills、workflows），这里同名的项会被跳过。直接编辑这个数组：删除不要的、修改 path、加自定义根、加 host:/ 直通根。browsable 是给文件浏览器类界面的 hint（WebUI 没有文件浏览页，不读它）。',
  nameLabel: '根名 (URI scheme)',
  nameDescription: '只允许字母/数字/下划线/连字符，且需以字母开头；如 workspace、share',
  pathLabel: '本机路径',
  pathDescription:
    '可绝对，亦可相对家目录；留空即默认工作区目录；不存在时自动创建。指向 / 即注册宿主机直通根（高危）。',
  labelLabel: '展示名称',
  kindLabel: '类型标签',
  kindDescription: '语义提示：workspace / data / tmp / pluginData / logs / custom / external / shared / host',
  browsableLabel: '文件浏览器可见 (hint)',
  browsableDescription: 'hint：给文件浏览器类界面用，WebUI 不读它',
  readableLabel: '允许读',
  writableLabel: '允许写',
  deletableLabel: '允许删除',
  badUri: '存储 URI 不合法：{uri}',
  readSecrets: '不能经存储读取宿主的密钥文件（只经宿主读写）',
  writeSecrets: '不能经存储修改宿主的密钥文件（只经宿主读写）',
  writeConfig: '不能经存储修改宿主的主配置（只经宿主修改）',
  containsControl: '目录里有宿主的密钥文件或主配置，不能经存储删除、移动或交出写权限',
  notDirectory: '不是目录',
  readDirectory: '不能读取目录',
  downloadDirectory: '不能下载目录',
  overwriteRoot: '不能覆盖根目录',
  overwriteDirectory: '不能覆盖目录',
  badFileName: '文件名不合法',
  renameRoot: '不能重命名根目录',
  nameExists: '目标名称已存在',
  moveRoot: '不能移动根目录',
  targetRoot: '目标不能是根目录',
  targetExists: '目标已存在',
  rootExists: '根目录已存在，无需创建',
  deleteRoot: '不能删除根目录',
  badPath: '路径不合法',
  otherRoot: 'URI 根 "{root}" 不是存储根 {name}（不能跨根移动）',
  notAllowed: '存储根 {name} 不允许该操作 ({permission})',
  symlink: '不允许写入符号链接',
  parentNotDirectory: '父路径不是目录',
  unknownRoot: '未知存储根：{root}（已注册根：{roots}）',
  unknownRootNone: '未知存储根：{root}（已注册根：（无））',
  noWritableRoots: '没有任何 writable 存储根',
  rootWritable: '根 {name} ({dir}) 可写',
  rootNotWritable: '根 {name} ({dir}) 不可写',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-storage-local', language: 'zh-CN', source: SOURCE, locales: { en } });
