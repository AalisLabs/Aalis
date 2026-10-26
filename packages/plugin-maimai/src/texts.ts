// 本插件自己的原文字典：查询与绑定的回复（工具与指令共用，工具取原文交给模型）与查分器报错
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  unreachable: '查分器暂时连不上，稍后再试（{reason}）',
  badToken: '查分器不认开发者凭据：检查配置项 developerToken（HTTP {status}：{message}）',
  replied: '查分器回复：{message}',
  noTarget: '解析目标失败',
  unknownSender: '认不出发消息的人（没有平台用户 id），绑定只能在认得出发送者的平台上做，如 QQ',
  noMemory:
    '没有在运行的记忆后端（绑定记在它里面）：在 WebUI 插件区启用一个（如 SQLite 记忆），或把它从配置文件的 disabledPlugins 里删掉；启用了还起不来就用 /doctor 看原因',
  byQq: '使用你的 QQ 号查询查分器（如失败请先 /maimai bind <好友码>）',
  noTargetHint: '未找到查询目标。请提供 friend_code/qq 参数，或先用 /maimai bind <好友码> 绑定自己。',
  noFriendCode: '按 QQ 号查到的玩家没有好友码：直接写好友码查，或先 /maimai bind <好友码> 绑定',
  queryFailed: '查询失败: {error}',
  hint: '({hint})',
  playerName: '{name}  (DX Rating: {rating})',
  playerCode: '好友码: {code}',
  playerTrophy: '称号: {name}',
  playerTrophyColor: '称号: {name} [{color}]',
  playerStar: '搭档觉醒: {star}',
  playerSynced: '同步时间: {time}',
  apBests: '【AP B50】',
  bestsTotal: 'B50 总分: {total}  (B35 旧版 {standard} + B15 现版 {dx})',
  bestsStandard: '— 旧版 B35 —',
  bestsDx: '— 现版 B15 —',
  noRecents: '（无最近游玩记录）',
  recentsHead: '最近 {count, number} 条游玩记录:',
  noKeyword: '请提供搜索关键词',
  noSong: '未找到匹配「{keyword}」的曲目',
  songsHead: '共 {count, number} 条匹配 (关键词: {keyword})',
  songTitle: '#{id} 《{title}》  by {artist}',
  songInfo: '  分类: {genre} | BPM: {bpm} | 版本: {version}',
  songAliases: '  别名: {aliases}',
  songAliasesMore: '  别名: {aliases} ...(+{more})',
  badFriendCode: '请提供有效的好友码（数字）',
  bindFailed: '绑定失败：{reason}',
  bound: '已将 {key} 绑定到好友码 {code}',
  unbindFailed: '解绑失败：{reason}',
  unbound: '已解绑你的舞萌 DX 好友码',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-maimai', language: 'zh-CN', source: SOURCE, locales: { en } });
