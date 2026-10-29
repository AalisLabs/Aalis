import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Browser tools',
  headlessLabel: 'Headless mode',
  headlessDescription: 'Whether to run the browser headless (no GUI window).',
  defaultTimeoutLabel: 'Default timeout (ms)',
  defaultTimeoutDescription: 'Default timeout for page navigation and actions.',
  viewportWidthLabel: 'Viewport width',
  viewportHeightLabel: 'Viewport height',
  maxPagesLabel: 'Max pages',
  maxPagesDescription: 'Maximum number of pages open at once. Beyond it, the earliest opened page is closed.',
  executablePathLabel: 'Chrome path',
  executablePathDescription:
    'Absolute path to a custom Chrome/Chromium executable. Left empty, the Chromium bundled with Puppeteer is used.',
  maxContentLengthLabel: 'Max content length',
  maxContentLengthDescription: 'Maximum number of characters of page text returned to the agent.',
  blockPrivateLabel: 'Block private and local networks',
  blockPrivateDescription:
    'Refuse localhost / 127.x / ::1 / 10.x / 172.16-31.x / 192.168.x / 169.254.x / 0.0.0.0 to prevent SSRF.',
  allowedProtocolsLabel: 'Allowed protocols',
  allowedProtocolsDescription: 'The browser may only visit URLs with these protocols.',
  allowedHostsLabel: 'Host allowlist',
  allowedHostsDescription:
    'Hosts that may be visited (private-network hosts must be listed here explicitly). Left empty, only blockPrivate decides.',
  browser: 'Browser',
  groupSummary: 'Web navigation, content extraction, screenshots and more with the Puppeteer headless browser',
  close: 'Close',
  closed: 'Closed {id}',
  pageMissing: 'Page {id} does not exist',
  closeAll: 'Close all pages',
  closeAllConfirm: 'Close all open pages?',
  closedAll: 'Closed all pages',
  openPages: 'Open pages',
  noOpenPages: 'No open pages',
  title: 'Title',
  url: 'Address',
  lastAccess: 'Last accessed',
  untitled: '(untitled)',
});
