// 本插件自己的原文字典：执行守卫的拒绝语（指令一路作为回复交给发出者，工具一路取原文交给模型）、权限页与权限组的文字
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  capabilityDenied: '已被系统禁用: {capability}',
  levelTooLow: '权限不足: "{capability}" 需等级 {required}（当前 {level}）',
  ownerOnlyCapability: '权限不足: "{capability}" 只限 owner',
  intentUnreachable: '操作已取消：{capability} 需要发出者本人确认，这条指令不是人亲手输入的，无从确认',
  intentDeclined: '操作已取消：{capability} 没有得到发出者确认',
  nobodyCan: '这一轮的参与者里没有人能做这件事',
  approvalsAbsent: '操作已取消：{capability} 需要批准，但审批服务不在（由 @aalis/plugin-session-server 提供）',
  operationsDescription:
    '每个指令、工具与设置项有一个最低等级：指令与工具默认按风险派生（安全 0、敏感 1、危险 2），设置项默认按声明；多数不用动。写在哪一层另有固定的门槛，不在这里调。',
  operationsEmpty: '没有登记的指令、工具或设置项',
  settingKind: '设置项',
  ownerOnlyLevel: '只有 owner',
  confirmSession: '每次（白名单可免）',
  confirmAlways: '每次（只有确认覆盖设为 off 能免）',
  rulesDescription:
    '禁用压过一切，连 owner 也拒。免确认只对以 owner 身份做的事生效：owner 本人、owner 派的子任务、owner 建的定时任务、定义者与调用者都是 owner 的编排；别人发起的、有别人的话一起进来的照旧要 owner 批准，不能产生审批的直接拒绝；不放宽等级。都可以写通配，如 tool:*。',
  waivePattern:
    '能力键或通配，如 tool:shell_exec、command:level、tool:*。只免以 owner 身份做的事的确认，别人发起的、有别人的话一起进来的照旧要 owner 批准',
  ownerOnly: '只有 owner 可管理权限',
  targetFormat: '目标格式: <platform:userId>',
  badGroupName: '组名只收字母、数字、连字符、下划线与中文，不以连字符开头：{name}',
  reservedGroupName: '{name} 是保留名，不能作组名',
  badEntries:
    '这些放行条目写法不对：{entries, list}；要写成 tool:<工具名>、command:<指令名>（都可用 * 通配）或 tool-group:<工具分组名>',
  unknownGroups: '没有这些权限组：{groups, list}；已有的组：{known, list}',
  noGroupsDefined: '没有这些权限组：{groups, list}；还没有建任何组',
  undefinedGroup: '{name}（未定义）',
  groupList: '{groups, list}',
  memberOf: '所属权限组：{groups, list}',
  permDescription: '设置用户所属的权限组；覆盖原有的，不给组名即清空。组在 WebUI 的权限页里建',
  groupsSet: '已设 {target} 的权限组：{groups, list}',
  groupsCleared: '已清空 {target} 的权限组',
  groupsTab: '权限组',
  groupsTable:
    '组只加放行：成员等级不够的操作，组里有一条覆盖它即可用，组之间合起来算；硬禁与封禁照旧先拒。组不开工具分组闸，会话没开的分组照旧看不到；需要确认的工具对不是 owner 的成员照旧用不了。和给他相应等级一样，成员在开了 system、code-runner、skills 等分组的会话里能用不需确认的本机读与执行（如 file_read、run_python）。通配与 tool-group: 会纳入以后新登记的工具。',
  groupsEmpty: '还没有权限组',
  groupName: '组名',
  groupGrants: '放行条目',
  groupMembers: '成员数',
  groupNameHint: '字母、数字、连字符、下划线与中文，不以连字符开头',
  grantsHint: '写成 tool:<工具名>、command:<指令名>（都可用 * 通配）或 tool-group:<工具分组名>；不收裸 *',
  createGroup: '建组',
  editGroup: '改条目',
  deleteGroup: '删除',
  deleteGroupConfirm: '删除这个组？成员记录里的组名保留但不再放行；之后建同名组会恢复这些成员。',
  groupExists: '已经有权限组 {name}',
  noSuchGroup: '没有权限组 {name}',
  groupCreated: '已建权限组 {name}',
  groupEdited: '已改权限组 {name} 的放行条目',
  groupDeleted: '已删除权限组 {name}',
  userGroups: '权限组',
  setUserGroups: '设权限组',
  userGroupsHint: '覆盖原有的；不选即清空',
  deleteUserConfirm: '删除这条记录？封禁的用户删掉记录就等于解封，所属权限组一并清掉。',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-authority', language: 'zh-CN', source: SOURCE, locales: { en } });
