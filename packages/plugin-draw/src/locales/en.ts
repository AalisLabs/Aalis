import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Drawing',
  groupSummary: 'Render SVG/HTML markup written by the model into images, sent into the chat with send_attachment',
  defaultWidthLabel: 'Default canvas width (px)',
  defaultWidthDescription: 'Canvas width used in HTML mode and for SVG without a declared width',
  maxWidthLabel: 'Max canvas width (px)',
  maxWidthDescription: 'Both the requested width and the width declared in the markup are capped to this value',
  maxPixelsLabel: 'Max canvas CSS pixels',
  maxPixelsDescription:
    'Upper limit of width×height (CSS pixels), 4MP by default. Note that the actual raster memory = this value × scale² (scale defaults to 2, i.e. 4 times); static images are screenshotted at scale, so the device pixel ceiling is scale² times this value. Work out the memory before raising it',
  maxSourceKBLabel: 'Max input markup (KB)',
  maxSourceKBDescription: 'Size limit of the source parameter',
  scaleLabel: 'Screenshot scale factor',
  scaleDescription: 'deviceScaleFactor: 2 = Retina sharpness (twice the pixels, larger files)',
  headlessLabel: 'Headless mode',
  headlessDescription: 'Can be turned off while debugging to watch the rendering page',
  executablePathLabel: 'Chrome path (left empty, detected automatically)',
  executablePathDescription:
    'Left empty, the Chrome cached by puppeteer is used (the same binary as the browser tools, in a separate process)',
  idleShutdownSecLabel: 'Idle shutdown (seconds)',
  idleShutdownSecDescription:
    'Shut Chromium down to free memory after the renderer has been idle this long; 0 = always on',
  maxConcurrencyLabel: 'Max concurrent renders',
  maxConcurrencyDescription:
    'Maximum number of render jobs at once; when many people in a group draw at the same time, the rest queue, so unbounded pages and ffmpeg do not bring the machine down',
  animMaxDurationSecLabel: 'Max animation duration (seconds)',
  animMaxDurationSecDescription: 'Hard limit on the animation duration of draw_animation',
  animDefaultFpsLabel: 'Default animation frame rate',
  animDefaultFpsDescription: 'Used when fps is not given explicitly; at most 25',
  animMaxFramesLabel: 'Max animation frames',
  animMaxFramesDescription:
    'When duration × frame rate exceeds it, the effective duration is derived from the frame count',
  animMaxOutputMBLabel: 'Max GIF size (MB)',
  animMaxOutputMBDescription:
    'Exceeding it is an error (OneBot inline delivery is limited to 10MB; this leaves headroom)',
  clearType: 'Image cache',
  cleared: 'Drawings cleared ({count, plural, one {# file} other {# files}})',
  clearFailed: 'Failed to clear drawings: {error}',
});
