import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  // ----- 插件、工具分组与版式 -----
  paper: 'Paper',
  works: 'Works',
  paperGroupSummary:
    'Have a remote agent create web pages, images, animations and other projects in the background, or keep editing an existing project; by default the result is reviewed and published per the paper config, or it can be created only, with the outputs to retrieve',
  worksGroupSummary: 'Nominate paper outputs to the works page and withdraw this room’s works',
  annotated: '{text} ({note})',
  joined: '{head} · {tail}',
  items: '{items, list}',

  // ----- 配置 -----
  globalCentsLabel: 'Global daily amount limit (cents)',
  globalCentsDescription:
    'How much all papers together may spend per day; leave empty for no limit, 0 blocks new tasks. A room’s own limit is remoteAgentRoomDailyCents, set per place',
  reserveLabel: 'Default reserve (cents)',
  reserveDescription:
    'When a task is accepted, the average cost of this paper’s last 5 booked tasks is reserved first; this value is used when there is no history',
  timeZoneLabel: 'Day rollover time zone',
  timeZoneDescription:
    'Daily limits reset at midnight in this time zone (an IANA name such as Asia/Shanghai); leave empty to use the host process’s local time zone',
  maxRunLabel: 'Per-run time limit (minutes)',
  maxRunDescription:
    'A remote run is cancelled once it has run this long; a timer enforces it, so it fires on time even when the remote side only sends heartbeats',
  sendHtmlLabel: 'Allow sending a single web page',
  sendHtmlDescription:
    'Whether paper_send may send a single HTML output back to the room as a file (the recipient opens it locally via file://, with no sandbox)',
  sendHtmlMaxLabel: 'Size limit for sending a web page (MB)',
  sendMediaMaxLabel: 'Size limit for sending images and videos (MB)',
  sendMediaMaxDescription:
    'Size limit for images and videos sent by paper_send. Outbound onebot only inlines media up to 10 MiB and hands larger files over by host path, which NapCat cannot read or send when it runs in a container',
  pendingHintLabel: 'Keep pending-delivery hints for (hours)',
  pendingHintDescription:
    'For finished tasks whose outputs have not been sent back, every conversation within this long after they end reminds the assistant to send them with paper_send',
  reconcileLabel: 'Periodic check interval (minutes)',
  reconcileDescription:
    'Interval for reconciliation (finding untracked runs and agents), idle archiving and periodic clearing',
  retentionLabel: 'Task record retention (days)',
  retentionDescription:
    'How long ended tasks stay in the ledger; run records are kept per agent until the agent is deleted',
  artifactsLabel: 'Output limits',
  artifactsDescription: 'Limits when collecting outputs; files over them are rejected',
  maxFileLabel: 'Single file (MB)',
  maxRunTotalLabel: 'Total per run (MB)',
  maxRunFilesLabel: 'Files per run',
  maxBundleLabel: 'Project bundle (MB)',
  maxPaperLabel: 'Total directory size per paper (MB)',
  maxPaperDescription:
    'Outputs stay on this machine until the paper is cleared; once this is exceeded, the remaining files are rejected and the paper is halted',
  defaultsLabel: 'Paper defaults',
  defaultsDescription:
    'Room papers without a name use this group; named papers also take any field they leave unset from it, except the daily amount',
  defaultCentsLabel: 'Daily amount limit per paper (cents)',
  defaultCentsDescription:
    'Total across all rooms sharing the paper; leave empty for no extra limit, 0 blocks tasks; global and room limits always apply',
  remoteTypeLabel: 'Remote agent type',
  remoteTypeDescription:
    'Remote agent plugin instance id (such as @aalis/plugin-remote-agent-cursor); empty turns remote tasks off',
  egressLabel: 'Egress limit',
  egressDescription:
    'Remote tasks do not start when the egress reported by the provider exceeds it; a report of “Unknown” counts as unrestricted',
  egressDefault: 'Use the default',
  egressNone: 'No egress',
  egressAllowlist: 'Allowlist only',
  egressOpen: 'Unrestricted',
  egressUnknown: 'Unknown',
  maxWaitingLabel: 'Unfinished task limit',
  maxWaitingDescription: 'Queued and in-progress tasks on one paper together may not exceed this number',
  maxPerUserLabel: 'Unfinished task limit per person',
  maxPerUserDescription: 'Unfinished tasks one person may have on a paper; leave empty for no per-person limit',
  clearAfterLabel: 'Periodic clearing (days)',
  clearAfterDescription:
    'Once this long has passed since the last clearing and the paper is idle, delete the remote agent and the paper directory (task records are kept)',
  rotateAfterLabel: 'Rotate at agent spending (cents)',
  rotateAfterDescription:
    'Once an agent’s total spending exceeds this, the next task creates a new agent (only the conversation resets; the project bundle carries over as usual)',
  idleArchiveLabel: 'Idle archiving (minutes)',
  idleArchiveDescription:
    'Archive the agent when no new task arrives this long after its last run ended (done during periodic checks)',
  publishTargetsLabel: 'Allowed publish targets',
  publishTargetsDescription:
    'Comma-separated target IDs (not URLs); works by default. An empty string disables publishing for this paper (a key written without a value counts as unset)',
  defaultTargetLabel: 'Default publish target',
  defaultTargetDescription:
    'When empty, a single allowed target is chosen automatically; with several targets one must be chosen each time. If set, it must be on the allowed list',
  papersLabel: 'Named papers',
  papersDescription:
    'A room that sets paperName in its session settings uses the paper of the same name here; rooms that write the same name share one paper',
  nameLabel: 'Name',
  nameDescription: 'Lowercase letters, digits and hyphens, up to 32 characters',
  paperCentsLabel: 'Daily amount limit for this paper (cents)',
  paperCentsDescription:
    'Leave empty for no per-paper limit (the default daily amount is not inherited); total across the rooms sharing this paper, 0 blocks tasks; global and room limits still apply',
  useDefaults: 'Leave empty to use the defaults',
  paperTargetsDescription:
    'Comma-separated target IDs; when unset (including a key written without a value) the defaults apply, and an empty string disables publishing for this paper',
  paperDefaultTargetDescription: 'When unset the defaults apply; an explicit empty value removes the default target',
  defaultsTargetsInvalid: 'defaults.publishTargets: {problem}',
  invalidTargetId: 'the publish targets contain an invalid target ID',
  egressNotOption: 'the egress limit is not one of the options',
  duplicateBroken: 'several entries share this name and some of them break the rules (see the startup log)',
  entryBroken: 'this entry has fields that break the rules (see the startup log)',
  paperEnabledLabel: 'Enable paper',
  paperEnabledDescription: 'Turn on the paper for this room',
  paperNameLabel: 'Paper name',
  paperNameDescription:
    'Leave empty to give each window its own paper with the attributes from the paper plugin’s defaults; windows that write the same name share one paper',
  remoteTypesLabel: 'Remote agent types',
  remoteTypesDescription: 'Allowed remote agent plugin instance ids; empty turns remote tasks off',
  userCentsLabel: 'Daily amount limit per person (cents)',
  userCentsDescription:
    'Leave empty for no extra per-person amount limit; 0 blocks new remote tasks; an invalid value counts as 0',
  userTasksLabel: 'Daily task limit per person',
  userTasksDescription: 'Leave empty for no per-person limit',
  userTasksUnset: 'No per-person limit',
  roomCentsLabel: 'Daily amount limit per room (cents)',
  roomCentsDescription:
    'Leave empty for no extra room amount limit; 0 blocks new remote tasks; an invalid value counts as 0',
  noExtraLimit: 'No extra limit',

  // ----- 远端错误的类别、时长与最近动作 -----
  categoryUnavailable: 'provider unavailable',
  categoryBusy: 'agent busy',
  categoryArchived: 'agent archived',
  categoryNotFound: 'not found remotely',
  categoryRateLimited: 'rate-limited remotely',
  categoryRejected: 'request rejected remotely',
  categoryTransient: 'temporary remote failure',
  categoryLocal: 'local processing error',
  durationMinutes: '{m} min {s} s',
  durationSeconds: '{s} s',
  actionPlanning: 'Planning',
  actionResponding: 'Responding',
  actionReading: 'Reading',
  actionWriting: 'Writing',
  actionCommand: 'Running a command',
  actionTool: 'Using a tool',
  activityRunning: 'in progress',
  activityCompleted: 'completed',
  activityFailed: 'failed',
  exitCode: 'exit code {code}',

  // ----- 额度（受理与出队时判，同时交给模型） -----
  globalZero: 'The global daily amount limit is 0; remote tasks will not start',
  globalOver:
    'Today’s global budget for remote tasks is not enough (cents used plus reserved: {used}; reserved for this task: {reserve}; limit: {limit})',
  paperZero: 'This paper’s daily amount limit is 0; remote tasks will not start',
  paperOver:
    'This paper’s budget for today is not enough (cents used plus reserved: {used}; reserved for this task: {reserve}; limit: {limit})',
  roomZero: 'This room’s daily amount limit (remoteAgentRoomDailyCents) is 0; remote tasks will not start',
  roomOver:
    'This room’s budget for today is not enough (cents used plus reserved: {used}; reserved for this task: {reserve}; limit: {limit})',
  userOver:
    'Your budget for today is not enough (cents used plus reserved: {used}; reserved for this task: {reserve}; limit: {limit})',
  userTasksOver: 'Tasks you submitted today: {count}; the daily limit per person is {limit}',

  // ----- 房间、隔离与远端条件（同时交给模型） -----
  roomPaperOff: 'Paper is not enabled in this room',
  paperBroken: 'The config of paper “{name}” is wrong ({problem}); it cannot be used until it is fixed',
  paperMissing:
    'The paper “{name}” set for this room does not exist (the paper plugin config has no such name under papers)',
  roomPaperLabel: 'Room paper {id}',
  profilePlatform: '{layer} “{platform}”',
  profilePlatformType: '{layer} “{platform} · {type}”',
  allRooms: 'all rooms under {layer}',
  pausedHalted: 'This paper is halted ({detail}); waiting for the owner to resume it in the WebUI',
  pausedUnknownAgent:
    'The account of remote agent “{type}” has an untracked agent; waiting for the owner to verify it in the WebUI and mark it as read',
  accountKeyEmpty: 'empty account id',
  accountKeyEmptyDetail: 'ready() reported an empty accountKey',
  blockedUnknown:
    'Could not get the remote account id of provider “{type}” ({category}); treated as sharing an account with the other papers',
  blockedCollision:
    'Papers {papers, list} use providers under the same remote account (agents on one account can read each other’s conversations)',
  accountIdOf: 'the remote account id of provider “{type}” ({category})',
  blockedOthersUnknown: 'Could not get {causes, list}; treated as sharing an account with this paper',
  ledgerDownPaused: 'The paper ledger could not be read; remote tasks are paused until the owner deals with it',
  noRemoteType: 'This paper has no remote agent type configured',
  roomDisallowsType: 'This room does not allow this paper’s remote agent type “{type}”',
  remoteAbsent: 'Remote agent “{type}” is not present',
  egressUnreadable: 'Could not get the egress of remote agent “{type}” ({category})',
  egressExceeds: 'The egress of remote agent “{type}” ({mode}) exceeds this paper’s limit ({ceiling})',
  sharedNeedsName:
    'Agents on the same account of remote agent “{type}” can read each other’s conversations, so it can only serve named papers; this room has no paper name set',

  // ----- 账本 -----
  ledgerFailure: 'Paper ledger {uri}: {reason}',
  ledgerReadFailed: 'read failed: {error}',
  ledgerParseFailed: 'parsing failed: {error}',
  ledgerBadShape: 'wrong structure (the version is not 1, or required tables are missing)',

  // ----- 诊断项 -----
  doctorOk: 'Paper config and ledger are fine',
  doctorLedgerDown: '{failure}; no remote tasks will start',
  doctorCollision:
    'Papers {papers, list} use providers under the same remote account (agents on one account can read each other’s conversations); none of them will start',
  doctorHalted: 'Paper {paper} is halted ({detail}); waiting for the owner to resume it in the WebUI',
  doctorUnknownAgent:
    'The account of remote agent “{type}” has an untracked agent {agent}; papers using it are halted until the owner verifies it in the WebUI and marks it as read',
  doctorAccountUnknown:
    'Could not get the remote account id of provider “{type}” (used by {papers, list}; reason: {detail}); treated as a conflict, so no named paper referencing providers of this kind will start',
  doctorTypesInherited:
    'remoteAgentTypes ({types, list}) is set in {layer}, so every room with paper enabled that this layer covers inherits it; set it per window in the room’s place settings instead',
  doctorRemoteAbsent: 'Remote agent “{type}” referenced by paper {name} is not present',
  doctorShared:
    'Paper {name} is shared by several rooms ({rooms, list}): the long-lived agent’s conversation and workspace are visible to all of them',
  doctorBroken:
    'The config of paper {name} is wrong ({problem}) and it is disabled: rooms using it have no paper, and later entries with the same name do not take effect until it is fixed',
  doctorGlobalZero: 'globalDailyCents is 0, so remote tasks will not start',
  doctorUnlimited:
    'The global daily budget is empty, so there is no limit: remote tasks are billed at actual cost; fill in an amount to set a limit',
  doctorClaimFailed:
    'Paper task {id} is still starting after claiming failed (room {room}): the run start is unknown and the run may be going remotely; if the provider stays unavailable, use “Stop tracking” in the task table',
  doctorListing:
    'During reconciliation, listing for remote agent “{type}” has been incomplete {count, plural, one {# time} other {# times}} in a row ({categories, list}); untracked agents and runs cannot be found meanwhile',
  doctorEgressUnverified:
    'The egress of remote agent “{type}” ({mode}) comes from the owner’s config and is unverified',
  doctorEgressFailed: 'Could not get the egress of remote agent “{type}”, so papers using it will not start: {error}',

  // ----- 运行驱动：页面动作与 paper_cancel 的拒绝与回执 -----
  noTask: 'No task {id}',
  ledgerWriteNotCancelled: 'Writing the paper ledger failed; the task was not cancelled',
  runUnknown:
    'The remote run of this task is unknown, so it cannot be cancelled; the owner should handle it in the WebUI',
  stillStarting: 'This task is starting its run; cancel it a little later',
  stillCollecting: 'This run has already ended and its outputs are being collected; it cannot be cancelled',
  taskEnded: 'This task has already ended ({state})',
  remoteAbsentCannotCancel: 'Remote agent “{type}” is not present, so the run cannot be cancelled',
  remoteCancelFailed: 'Remote cancellation failed ({category})',
  cancelRequested: 'Asked the remote side to cancel this run; costs are booked as actually incurred',
  noPaperInLedger: 'The ledger has no such paper',
  notWaitingBundle: 'This paper is not waiting for an old project bundle',
  noAgentInUse: 'This paper has no agent in use',
  unfinishedNoArchive: 'This paper has unfinished tasks; archive it after they are done',
  archivedSelfWake: 'The agent had untracked runs and was handled as a self-wake (paper halted, agent deleted)',
  archiveFailed: 'Archiving failed: {error}',
  clearPublishing:
    'This paper has works waiting to be submitted or already submitted for publishing; clear it after publishing finishes',
  clearRunning: 'This paper has a task running; wait for it to end or cancel it before clearing',
  abandonRunning:
    'A running task can only stop being tracked after its timed cancellation failed and the paper was halted; try “Cancel task” first',
  abandonStarting:
    'A starting task can only stop being tracked after its run start became unknown and claiming it failed',
  abandonOther: 'Only running and starting tasks can stop being tracked',
  writeOffUnfinished: 'This task has not ended yet; its reserve is booked at actual cost once it ends',
  writeOffNoReserve: 'This task holds no reserve',

  // ----- 运行驱动：任务的失败原因（同时交给模型） -----
  abandonedRunning:
    'The remote run could not be cancelled and the owner stopped tracking it; it may still be running remotely, and its costs will be booked after the run ends',
  abandonedStarting:
    'The run start was unknown and could not be claimed, so the owner stopped tracking it; a run may have started remotely, and its costs will be booked to this task once runs can be listed',
  remoteBusy: 'The remote side is busy or unavailable',
  paperUnconfigured: 'This paper is no longer in the config, or has no remote agent type configured',
  dequeueRefused: 'Checks failed when leaving the queue: {reason}',
  roomSwitchedPaper: 'the originating room now uses a different paper',
  missingWorkspace:
    'Could not get the old project bundle, so rotation stopped and the old agent was kept; save a project bundle in the old workspace and retry. If the old bundle can never be retrieved, the owner can click “Continue without the old project” on the Paper page',
  missingPreviousWorkspace:
    'Could not get the previous agent’s project bundle, so the new agent cannot continue the original project; the owner can click “Continue without the old project” on the Paper page (outputs and records are kept), or clear the paper',
  startingAgentMissing: 'The ledger has no record of the agent being started',
  createFailed: 'Creating the remote agent failed ({category})',
  agentFailed: 'The remote agent failed ({category})',
  startRefused: 'The remote side refused to start a run ({category})',
  runExpired: 'The remote run expired',
  runLost: 'The remote run failed or no longer exists',
  collectFailed: 'Collecting outputs failed ({category})',

  // ----- 运行驱动：停开说明与告警 -----
  providerUnavailable: 'Remote agent “{type}” is unavailable ({category})',
  timeoutCancelFailed: 'The timed-out run {run} of paper task {id} could not be cancelled',
  storageFull:
    'The paper directory exceeded its total size limit of {bytes} bytes; the remaining outputs of task {id} were rejected',
  costMissing:
    'The cost of run {run} could not be obtained; the reserve is kept as provisional spending. Resume in the WebUI after verifying',
  selfWake:
    'Runs not in the ledger appeared on agent {name} ({agent}): {runs, list}; handled as a self-wake: the agent is cancelled and deleted, and the next new agent starts without the old project bundle',
  waitedTooLong: 'waited past the limit',
  claimFailedAlert:
    'The run start was unknown and paper task {id} could not be claimed ({cause}); it stays starting with its reserve held, and the run may be going remotely. If the provider stays unavailable, use “Stop tracking” in the task table',
  claimUnverified:
    'The run start was unknown, so paper task {id} claimed the only untracked run {run} on agent {agent}; there is no telling whether this task started it or the agent woke itself, so check in the remote console',
  orphanClaimed:
    'Paper task {id} was no longer tracked and its run start was unknown; the only untracked run {run} on agent {agent} was booked to it. There is no telling whether this task started it or the agent woke itself, so check in the remote console',
  untrackedCancelFailed: 'Untracked run {run} could not be cancelled (it ends when the agent is deleted): {error}',
  deleteFailed: 'Deleting remote agent {name} ({agent}) failed; retrying at the next reconciliation: {error}',
  costEstimated:
    'Agent {agent} was deleted and the cost of run {run} could not be obtained; booked an estimate of {cents, plural, one {# cent} other {# cents}}. Verify it in the remote console',
  untrackedAgent: 'The account has an untracked agent {name} ({agent})',
  listRunsFailed: 'listing runs: {category}',
  listAgentsFailed: 'listing agents: {category}',

  // ----- 发布：没能上线的原因（同时交给模型） -----
  creationCancelled: 'The creation task was cancelled; nothing was submitted for publishing',
  creationFailed: 'The creation task failed; nothing was submitted for publishing',
  submitTimedOut:
    'Could not submit for publishing within 24 hours (the publish target or publish service stayed unavailable)',
  targetNotAllowed: 'This paper is not allowed to use that publish target',
  receiptUnverified: 'The origin of the publishing receipt could not be verified',
  publishOutcome: 'Publishing ended: {state}',
  selectedGone: 'The selected outputs no longer exist',
  selectedPathsBad: 'The selected work paths do not meet the publishing requirements',
  coverGone: 'The selected cover no longer exists',
  publishCheckFailed: 'The work did not pass the publishing checks',
  noSingleEntry: 'Could not determine a single web page entry; choose the outputs manually',
  mixedDirectories: 'The outputs are in different directories; choose the outputs manually',
  pathsBad: 'The work paths do not meet the publishing requirements; choose the outputs manually',

  // ----- 白纸页与会话面板 -----
  stateQueued: 'Queued',
  stateStarting: 'Starting',
  stateRunning: 'Running',
  stateCollecting: 'Collecting outputs',
  stateDone: 'Done',
  stateFailed: 'Failed',
  cancelled: 'Cancelled',
  viaTool: 'tool',
  viaWebui: 'WebUI',
  viaTimeout: 'timed out',
  stateWithError: '{state}: {error}',
  publicationPending: 'Waiting to be submitted',
  publicationSubmitted: 'Being published',
  publicationLive: 'Live',
  publicationFailed: 'Not published',
  publicationState: '{target}: {state}',
  publicationWithReason: '{target}: {state} ({reason})',
  noPublication: 'Not publishing',
  paperHalted: 'Halted: {detail}',
  paperOk: 'OK',
  agentCreating: 'creating',
  agentActive: 'active',
  agentArchived: 'archived',
  agentRetired: 'retired',
  alertUnknownRun: 'Untracked run',
  alertUnknownAgent: 'Untracked agent',
  alertCostMissing: 'Cost unavailable',
  alertProvider: 'Provider unavailable',
  alertDeleteFailed: 'Agent deletion failed',
  alertCancelFailed: 'Cancellation failed',
  alertStorageFull: 'Directory usage over limit',
  alertCostEstimated: 'Cost booked as an estimate',
  alertClaimUnverified: 'Claim unverified',
  alertClaimFailed: 'Claim failed',
  artifactOther: 'other',
  taskName: 'Task name',
  status: 'Status',
  latestActivity: 'Latest activity',
  activityAt: 'Activity time',
  initiator: 'Initiator',
  file: 'File',
  preview: 'Preview',
  task: 'Task',
  type: 'Type',
  size: 'Size',
  noSuchPaper: 'No such paper',
  reservedCents: 'Reserved {cents, number}',
  providerAbsent: 'Provider not present',
  readFailed: 'Read failed: {error}',
  egressVerified: '{mode}; limit {ceiling}',
  egressUnverified: '{mode} (owner config, unverified); limit {ceiling}',
  paperGone: 'This paper is no longer in the config',
  paperGoneParen: '(this paper is no longer in the config)',
  budgetUnlimited: 'Unlimited (neither this paper nor the global setting has a limit; room limits apply separately)',
  budgetShared: 'No separate limit (global and room limits still apply)',
  budgetZero: 'Limit 0 cents (tasks blocked)',
  budgetCents: 'Limit {cents, plural, one {# cent} other {# cents}}',
  publishForbidden: '(publishing disabled)',
  publishServiceAbsent: 'publish service not present',
  unregistered: 'not registered',
  targetTitle: '{name} / {label}',
  targetUrl: '{title}: {url}',
  available: 'available',
  unavailable: 'unavailable',
  unavailableBecause: 'unavailable: {reason}',
  targetsReadFailed: '(could not read the publish targets)',
  sharingRooms: 'Sharing rooms',
  sharedRooms: 'Shared ({count, number}): {rooms, list}',
  remoteType: 'Remote type',
  notConfigured: '(not configured)',
  egress: 'Egress',
  availableTargets: 'Available publish targets',
  chooseEachTime: '(choose each time)',
  dailyBudget: 'Daily budget',
  dailyBudgetValue:
    '{limit}; booked {spent, plural, one {# cent} other {# cents}}; reserved {reserved, plural, one {# cent} other {# cents}}',
  dailyBudgetUnattributed:
    '{limit}; booked {spent, plural, one {# cent} other {# cents}}; reserved {reserved, plural, one {# cent} other {# cents}}; unattributed costs (including old entries) of {unattributed, plural, one {# cent} other {# cents}} are counted conservatively against every paper’s budget',
  usage: 'Directory usage / limit',
  bundle: 'Project bundle (local path)',
  haltReason: 'Halt reason',
  haltedAt: '{detail} ({at, datetime, short})',
  globalScope: 'Global ({day}, unlimited)',
  globalScopeLimit: 'Global ({day}, limit {cents, plural, one {# cent} other {# cents}})',
  roomScope: 'Room {room}',
  initiatorScope: 'Initiator {user}',
  ledgerDown: 'The paper ledger could not be read; waiting for the owner',
  cancelConfirm:
    'Cancel this task? If it is running, the remote side is asked to cancel this run; costs already incurred are booked as usual.',
  badTaskId: 'Invalid task ID',
  rotate: 'Rotate',
  rotateConfirm:
    'The next task creates a new agent. Rotating only resets the conversation; the project bundle carries over to the new agent as usual. To wipe the workspace, use “Clear”. Continue?',
  rotated: 'The next task will create a new agent',
  archiveAgent: 'Archive agent',
  archived: 'Archived',
  clear: 'Clear',
  clearConfirm:
    'Clear this paper: cancel the queued tasks and delete the remote agent (with its conversation and workspace) and the local paper directory (outputs and project bundle). Task records are kept. Continue?',
  cleared: 'Cleared',
  resume: 'Resume',
  notHalted: 'This paper is not halted',
  resumed: 'Resumed',
  freshStart: 'Continue without the old project',
  freshStartConfirm:
    'Use this when the old project bundle can never be retrieved: the new agent stops waiting for it and continues from its own workspace (or an empty project). Outputs and task records on the paper are kept; progress in the old project that was not handed over is lost. Continue?',
  freshStarted: 'The next task will no longer wait for the old project bundle',
  cancelTask: 'Cancel task',
  abandon: 'Stop tracking',
  abandonConfirm:
    'This task will be marked as failed. The remote run may still be running or may have started; its costs are booked once it can be listed and has ended. The next task creates a new agent. Continue?',
  abandoned: 'Stopped tracking',
  writeOff: 'Write off reserve',
  writeOffConfirm:
    'Use this when the cost can never be obtained: the unbooked cost of this ended task is booked to today’s spending at its reserve amount, the reserve is released, and the cost is not fetched again. Continue?',
  writtenOff: 'Written off',
  markRead: 'Mark as read',
  noUnreadAlert: 'No such unread alert',
  markedRead: 'Marked as read',
  deleteLog: 'Delete log',
  deleteLogConfirm: 'Only delete this task’s creation log, not the project or works. Continue?',
  logBusy: 'The task is still being created or published, so its log cannot be deleted',
  deleteLogFailed: 'Deleting the creation log failed: {error}',
  logDeleted: 'Creation log deleted',
  papersTab: 'Papers',
  noPapers: 'No papers yet',
  boundAgent: 'Bound agent',
  spentToday: 'Spent today (cents)',
  tasks: 'Tasks',
  noPaperTasks: 'This paper has no tasks yet',
  room: 'Room',
  duration: 'Duration',
  costCents: 'Cost (cents)',
  publication: 'Publication',
  request: 'Request',
  outputs: 'Outputs',
  noPaperOutputs: 'This paper has no outputs',
  remotePath: 'Path given by the remote side',
  todaySpend: 'Today’s spending',
  scope: 'Scope',
  taskCount: 'Tasks',
  reservedColumn: 'Reserved (cents)',
  alerts: 'Alerts',
  noAlerts: 'No alerts',
  message: 'Message',
  kind: 'Kind',
  time: 'Time',
  read: 'Read',
  unread: 'Unread',
  logsTab: 'Creation logs',
  noLogs: 'No creation logs yet',
  entries: 'Entries',
  taskId: 'Task ID',
  taskArchived: '(task record archived)',
  recentRecords: 'Latest {count} entries',
  noLogYet: 'No creation log has been recorded yet; older tasks are not backfilled.',
  fullLogAt: 'The full log is at {uri, code}.',
  notInThisRoom: 'This room has no such task',
  resumeRoomPaper: 'Resume paper',
  roomSpentToday: 'Spent in this room today (cents)',
  roomReserved: 'Reserved in this room (cents)',
  roomDailyLimit: 'Daily limit for this room',
  roomUnlimited: 'Unlimited',
  roomLimitCents: '{cents, plural, one {# cent} other {# cents}}',
  roomLimitInvalid: 'Invalid, treated as 0',
  paperSpentToday: 'Paper spent today (cents)',
  paperDailyLimit: 'Daily limit for the paper',
  roomTasks: 'Tasks in progress',
  noRoomTasks: 'No tasks in progress in this room',
  recentOutputs: 'Recent outputs',
  noRoomOutputs: 'No outputs in this room yet',
  ledgerDownTitle: 'The paper ledger could not be read',
  ledgerDownDetail:
    '{failure}; no remote tasks will start and the original file is not overwritten. Fix or move it, then restart',
  unreadAlerts: '{count, plural, one {# unread paper alert} other {# unread paper alerts}}',

  // ----- 完成通知给人看的那句 -----
  notice: '[Paper] Task {id} “{name}” {outcome}.{took}{cost}',
  took: ' Took {ms, duration}.',
  cost: ' Cost {cents, plural, one {# cent} other {# cents}}.',
  costPending: ' The cost has not been booked yet.',
  outcomeDone: 'completed',
  outcomeUnpublished: 'was not published: {reason}',
  outcomeUnpublishedUnknown: 'was not published: publishing failed',
  outcomeFailed: 'failed: {error}',
  outcomeFailedUnknown: 'failed for an unknown reason',
  outcomeTimeout: 'exceeded the per-run time limit and was cancelled',
  outcomeOwnerCancelled: 'was cancelled by the owner',
  outcomeRemoteCancelled: 'was cancelled remotely',
});
