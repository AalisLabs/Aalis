import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  capabilityDenied: 'Disabled by the system: {capability}',
  levelTooLow: 'Insufficient permission: "{capability}" needs level {required} (current {level})',
  ownerOnlyCapability: 'Insufficient permission: "{capability}" is owner-only',
  intentUnreachable:
    'Operation cancelled: {capability} needs confirmation from the sender in person, but this command was not typed by a person, so it cannot be confirmed',
  intentDeclined: 'Operation cancelled: {capability} was not confirmed by the sender',
  approvalsAbsent:
    'Operation cancelled: {capability} needs owner approval, but the approval service is absent (provided by @aalis/plugin-session-server)',
  operationsDescription:
    'Each command, tool and setting has a minimum level: commands and tools default to one derived from their risk (safe 0, sensitive 1, dangerous 2), settings to the level they declare; most need no change. Which layer a setting is written to has its own fixed threshold, not adjusted here.',
  operationsEmpty: 'No commands, tools or settings are registered',
  settingKind: 'Setting',
  ownerOnlyLevel: 'Owner only',
  confirmSession: 'Every time (the waiver list can waive it)',
  confirmAlways: 'Every time (only a confirmation override set to off waives it)',
  rulesDescription:
    'Disabling overrides everything, owners included. Waiving confirmation only applies to what is done as an owner: the owner in person, subtasks the owner dispatched, scheduled tasks the owner created, and workflows whose definer and caller are both owners; anything started by others still needs owner approval, and is refused where no approval can be raised. Neither lowers levels. Both accept wildcards, such as tool:*.',
  waivePattern:
    'A capability key or wildcard, such as tool:shell_exec, command:level, tool:*. Only waives confirmation for what is done as an owner; anything started by others still needs owner approval',
  ownerOnly: 'Only an owner can manage permissions',
  targetFormat: 'Target format: <platform:userId>',
  badGroupName:
    'A group name can only contain letters, digits, hyphens, underscores and Chinese characters, and cannot start with a hyphen: {name}',
  reservedGroupName: '{name} is a reserved name and cannot be used as a group name',
  badEntries:
    'These grant entries are malformed: {entries, list}; write them as tool:<tool name>, command:<command name> (both accept * wildcards) or tool-group:<tool group name>',
  unknownGroups: 'No such permission groups: {groups, list}; existing groups: {known, list}',
  noGroupsDefined: 'No such permission groups: {groups, list}; no group has been created yet',
  undefinedGroup: '{name} (undefined)',
  groupList: '{groups, list}',
  memberOf: 'Permission groups: {groups, list}',
  permDescription:
    "Set a user's permission groups; replaces the current ones, and giving no group names clears them. Groups are created on the permissions page in the WebUI",
  groupsSet: 'Set the permission groups of {target}: {groups, list}',
  groupsCleared: 'Cleared the permission groups of {target}',
  groupsTab: 'Permission groups',
  groupsTable:
    "Groups only grant: an operation above a member's level is allowed when an entry in one of their groups covers it, and groups add up; hard denials and bans still refuse first. Groups do not open tool group gates, so groups the session has not enabled stay hidden; tools that need confirmation stay unavailable to members who are not owners. Just like giving them the matching level, members can use local reads and execution that need no confirmation (such as file_read, run_python) in sessions with groups like system, code-runner and skills enabled. Wildcards and tool-group: also cover tools registered later.",
  groupsEmpty: 'No permission groups yet',
  groupName: 'Group name',
  groupGrants: 'Grant entries',
  groupMembers: 'Members',
  groupNameHint: 'Letters, digits, hyphens, underscores and Chinese characters; cannot start with a hyphen',
  grantsHint:
    'Write tool:<tool name>, command:<command name> (both accept * wildcards) or tool-group:<tool group name>; a bare * is not accepted',
  createGroup: 'Create group',
  editGroup: 'Edit entries',
  deleteGroup: 'Delete',
  deleteGroupConfirm:
    'Delete this group? Members keep the group name in their records but it no longer grants anything; creating a group with the same name later restores them.',
  groupExists: 'Permission group {name} already exists',
  noSuchGroup: 'No permission group {name}',
  groupCreated: 'Created permission group {name}',
  groupEdited: 'Updated the grant entries of permission group {name}',
  groupDeleted: 'Deleted permission group {name}',
  userGroups: 'Permission groups',
  setUserGroups: 'Set groups',
  userGroupsHint: 'Replaces the current ones; select none to clear them',
  deleteUserConfirm:
    'Delete this record? Deleting the record of a banned user unbans them, and their permission groups are cleared too.',
});
