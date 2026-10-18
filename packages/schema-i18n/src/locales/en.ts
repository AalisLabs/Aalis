import { defineLocale } from '../define.js';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({ lines: '{items, lines}', clauses: '{head}; {tail}', listSeparator: ', ' });
