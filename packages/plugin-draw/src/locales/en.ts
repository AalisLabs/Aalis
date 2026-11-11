import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Drawing',
  groupSummary: 'Render SVG/HTML markup written by the model into images, sent into the chat with send_attachment',
  defaultWidthLabel: 'Default canvas width (px)',
  defaultWidthDescription: 'Canvas width used in HTML mode and for SVG without a declared width',
  maxWidthLabel: 'Max canvas width (px)',
  maxWidthDescription: 'Both the requested width and the width declared in the markup are capped to this value',
  maxPixelsLabel: 'Max canvas pixels',
  maxPixelsDescription:
    'Pixel limit (width × height) of the output image, per frame for animations, 4MP by default. Static images get a smaller canvas by the screenshot scale factor, so the scaled output stays within it.',
  maxSourceKBLabel: 'Max input markup (KB)',
  maxSourceKBDescription: 'Size limit of the source parameter',
  scaleLabel: 'Screenshot scale factor',
  scaleDescription:
    'Screenshot scale for static images; 2 gives sharp output (twice the width and height, larger files)',
  headlessLabel: 'Headless mode',
  headlessDescription: 'Can be turned off while debugging to watch the rendering page',
  executablePathLabel: 'Chrome path',
  executablePathDescription:
    'Absolute path to Chrome. Left empty, the executable in the puppeteer configuration is used, or the Chrome bundled with puppeteer if none is configured.',
  sandboxLabel: 'Chromium sandbox',
  sandboxDescription:
    'When on, Chromium starts with its sandbox, so markup that takes over the renderer process still cannot leave it. As root on Linux, or in a container without a usable sandbox, Chromium then cannot start.',
  idleShutdownSecLabel: 'Idle shutdown (seconds)',
  idleShutdownSecDescription:
    'Shut Chromium down to free memory after the renderer has been idle this long; 0 = always on',
  maxConcurrencyLabel: 'Max concurrent renders',
  maxConcurrencyDescription: 'Maximum number of render jobs at once; the rest queue',
  animMaxDurationSecLabel: 'Max animation duration (seconds)',
  animMaxDurationSecDescription: 'Hard limit on the animation duration of draw_animation',
  animDefaultFpsLabel: 'Default animation frame rate',
  animDefaultFpsDescription: 'Used when fps is not given explicitly; at most 25',
  animMaxFramesLabel: 'Max animation frames',
  animMaxFramesDescription:
    'When duration × frame rate exceeds it, the effective duration is derived from the frame count',
  animMaxOutputMBLabel: 'Max GIF size (MB)',
  animMaxOutputMBDescription: 'A generated GIF larger than this is an error; at most 9',
  clearType: 'Image cache',
  cleared: 'Cleared drawings ({count, plural, one {# file} other {# files}})',
  clearFailed: 'Failed to clear drawings: {error}',
});
