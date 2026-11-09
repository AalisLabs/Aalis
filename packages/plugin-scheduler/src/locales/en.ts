import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Scheduled tasks',
  groupSummary: 'Create, view and cancel scheduled or recurring autonomous action plans',
  jobsLabel: 'Scheduled tasks',
  jobsDescription: 'Configure scheduled or recurring tasks so the AI carries out plans on its own.',
  jobNameLabel: 'Task name',
  cronLabel: 'Cron expression',
  cronDescription:
    '5-field format: minute hour day month weekday (e.g. "0 9 * * *" = every day at 9:00). Use either this or “Fixed interval”.',
  intervalLabel: 'Fixed interval (seconds)',
  intervalDescription: 'Run once every N seconds. Use either this or “Cron expression”.',
  runAtLabel: 'One-time run at',
  runAtDescription: 'An ISO string; disabled automatically after running once.',
  sessionIdLabel: 'Target session ID',
  sessionIdDescription:
    'ID of the session task messages are sent to. Can be a real group or user session, or a custom one (such as scheduler::daily).',
  platformLabel: 'Target platform',
  platformDescription:
    'Platform identifier of task messages (such as internal, webui, onebot). Only used for message routing.',
  actorPlatformLabel: 'Run-as identity: platform',
  actorPlatformDescription:
    'platform of the acting identity (separate from the target platform). authority decides capabilities by (actorPlatform, actorUserId) together. Fill it in together with Run-as identity: user ID; with neither, the task runs as the owner; filling in only one is a configuration error and the task is not loaded.',
  actorUserIdLabel: 'Run-as identity: user ID',
  actorUserIdDescription:
    'userId of the acting identity. Fill it in together with Run-as identity: platform; with neither, the task runs as the owner; filling in only one is a configuration error and the task is not loaded.',
  contentLabel: 'Message content',
  contentDescription: 'The instruction or prompt sent to the agent.',
  enabledLabel: 'Enabled',
  timeZoneLabel: 'Time zone (IANA)',
  timeZoneDescription:
    'Time zone for evaluating cron, such as Asia/Shanghai or Europe/London. Left empty = the local time zone of the process. Only applies to cron tasks.',
  persistPathLabel: 'Dynamic task storage path',
  persistPathDescription:
    'Tasks created by the AI or in the WebUI are persisted to this storage URI and loaded again after a restart.',
  badPersistPath:
    'persistPath="{value}" is not a storage URI: write it as <root>:/<path> (such as data:/scheduler-jobs.json), or delete the key to use the default',
  fieldCronDescription:
    '5 fields or an alias: @hourly, @daily, @weekly, @every 30s; exactly one of this, fixed interval, one-time run at and run once after X seconds',
  fieldIntervalLabel: 'Fixed interval (seconds)',
  fieldIntervalDescription:
    'At least 5 and at most {max, number} (about 24.8 days); exactly one of the four scheduling methods',
  fieldRunAtDescription: 'An ISO time, such as 2026-05-19T10:00:00; deleted automatically after running once',
  delaySecondsLabel: 'Run once after X seconds',
  delaySecondsDescription: 'Converted to a one-time run at = now + N seconds; deleted automatically after running once',
  fieldContentDescription: 'The instruction or prompt to send to yourself at that time',
  paused: 'Paused',
  pausedDescription:
    'When checked, the task does not run on its own until resumed by hand; only for recurring tasks (cron, fixed interval)',
  scheduleMissing: 'One of cron, fixed interval, one-time run at and run once after X seconds must be filled in',
  scheduleConflict:
    'cron, fixed interval, one-time run at and run once after X seconds are mutually exclusive; fill in only one',
  pauseOneShot: 'Pausing has no usable meaning for one-time tasks (one-time run at, run once after X seconds)',
  intervalTooShort:
    'The fixed interval cannot be less than 5 seconds (so high-frequency tasks do not use up resources)',
  sessionIdEmpty: 'The target session ID cannot be empty',
  contentEmpty: 'The message content cannot be empty',
  duplicateName: 'A task named {name} already exists; use “Edit” to change it',
  tooManyJobs:
    'This session has reached the limit of {max, number} scheduled tasks; delete some tasks before creating a new one',
  pageTitle: 'Scheduled tasks',
  create: 'New',
  name: 'Name',
  nameDescription: 'Unique identifier of the task',
  nameEmpty: 'The name cannot be empty',
  edit: 'Edit',
  jobMissing: 'Task {name} does not exist',
  triggerNow: 'Run now',
  jobRunning: 'Task {name} is running, so it was not triggered again',
  triggered: 'Ran {name}',
  pause: 'Pause',
  cannotPause: 'The task does not exist, or is a one-time task (cannot be paused, only deleted and recreated)',
  pausedReceipt: 'Paused {name}',
  resume: 'Resume',
  resumed: 'Resumed {name}',
  delete: 'Delete',
  deleteConfirm: 'Delete this scheduled task?',
  deleted: 'Deleted {name}',
  noJobs: 'No scheduled tasks yet',
  schedule: 'Schedule',
  target: 'Target session',
  status: 'Status',
  nextRun: 'Next run',
  lastRun: 'Last run',
  runCount: 'Runs',
  lastResult: 'Last result',
  everySeconds: 'Every {seconds} s',
  oneShot: 'Once at {at}',
  unset: 'Not set',
  statusDisabled: 'Disabled',
  statusRunning: 'Running',
  statusReady: 'Ready',
  jobSucceeded: 'Succeeded',
  jobFailed: 'Failed: {error}',
  notArray: 'The persisted task file is not an array (got {got})',
  loadFailedTitle: 'The scheduled task file {uri} could not be read, so the tasks in it were not loaded',
  loadFailedReading:
    'Make sure the root name in the persistPath setting is right and this file can be read, then reload this plugin. Until it is fixed, tasks created or changed only take effect for this run. Reason: {error}',
  loadFailedContent:
    "Fix this file, then reload this plugin: its content must be an array of tasks; if you don't want the tasks in it, move it away and reload. Until it is fixed, tasks created or changed only take effect for this run. Reason: {error}",
  unscheduledTitle: 'Scheduled task “{name}” could not be scheduled and will not run',
  unscheduledInConfig:
    "Fix this task's scheduling method or timeZone in the configuration file; it takes effect once saved. Reason: {error}",
  unscheduledOnPage: 'Edit this task on the scheduled task page, fix its scheduling method and save. Reason: {error}',
  halfActorTitle: 'Scheduled task “{name}” was not loaded: only half of the run-as identity is filled in',
  halfActorDetail:
    "In the configuration file, write this task's actorPlatform and actorUserId as a pair, or delete both (to run as the owner); it takes effect once saved.",
  fromConfig: 'Task “{name}” comes from the configuration file; change it there',
  disposed: 'The scheduler service has been closed, so task {name} was not accepted',
  jobSaved: 'Saved task {name}',
  notPersisted:
    'only effective for this run, not written to {uri}: it could not be read; see Needs attention for how to fix it',
});
