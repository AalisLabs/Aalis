// 本插件自己的原文字典：平台通知、请求事件合成的入站与戳一戳、群文件上传转成的入站给人看的那句（写给模型的正文另带
// [notice/…]、处理办法与工具用法）
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  // 称呼：在句首作主语的用 …Subject（英文首字母大写），其余位置用前三个
  self: '我',
  someone: '某人',
  admin: '管理员',
  selfSubject: '我',
  someoneSubject: '某人',
  adminSubject: '管理员',
  friendRequest: '用户 {user} 向我发出了好友申请',
  friendRequestWithComment: '用户 {user} 向我发出了好友申请，验证信息："{comment}"',
  groupInvite: '用户 {user} 邀请我加入群 {group}',
  groupInviteWithComment: '用户 {user} 邀请我加入群 {group}，备注："{comment}"',
  joinRequest: '用户 {user} 申请加入群 {group}',
  joinRequestWithComment: '用户 {user} 申请加入群 {group}，备注："{comment}"',
  muteRecovered: '检测到我在该群仍处于禁言状态，剩余约 {ms, duration}',
  banned: '{op} 把 {target} 禁言了 {ms, duration}（解禁于 {until, datetime, short}）',
  bannedUnknown: '{op} 把 {target} 禁言了 若干时间',
  banLifted: '{op} 把 {target} 解除了禁言',
  recalled: '{user} 撤回了一条消息',
  recalledOther: '{op} 撤回了 {user} 的消息',
  recalledPrivate: '{user} 撤回了一条私聊消息',
  joined: '{user} 加入了群',
  joinedInvited: '{user} 被 {op} 邀请加入了群',
  removed: '{user} 被 {op} 移出群聊',
  left: '{user} 退出了群聊',
  adminSet: '{user} 被设置为管理员',
  adminUnset: '{user} 被取消管理员',
  adminChanged: '{user} 管理员状态变化',
  friendAdded: '{user} 成为了我的好友',
  poked: '{user} 戳了我',
  pokedOther: '{user} 戳了 {target}',
  uploaded: '{user} 上传了 {file}',
  unknownFile: '未知文件',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-adapter-onebot',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});
