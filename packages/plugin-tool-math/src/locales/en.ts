import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Math tools',
  groupSummary:
    'Expression evaluation, statistics, matrices, number theory, geometry, unit conversion, financial math, calculus, equation solving and base conversion',
  evaluateLabel: 'Expression evaluation',
  evaluateEnabledLabel: 'Enable expression evaluation tools',
  statisticsLabel: 'Statistics',
  statisticsEnabledLabel: 'Enable statistics tools',
  matrixLabel: 'Matrix operations',
  matrixEnabledLabel: 'Enable matrix tools',
  numberTheoryLabel: 'Number theory and combinatorics',
  numberTheoryEnabledLabel: 'Enable number theory tools',
  geometryLabel: 'Geometry',
  geometryEnabledLabel: 'Enable geometry tools',
  conversionLabel: 'Unit conversion',
  conversionEnabledLabel: 'Enable unit conversion tools',
  financialLabel: 'Financial math',
  financialEnabledLabel: 'Enable financial math tools',
  calculusLabel: 'Calculus',
  calculusEnabledLabel: 'Enable calculus tools',
  equationLabel: 'Equation solving',
  equationEnabledLabel: 'Enable equation solving tools',
  baseConvertLabel: 'Base conversion',
  baseConvertEnabledLabel: 'Enable base conversion tools',
  symbolicLabel: 'Symbolic algebra (mathjs)',
  symbolicEnabledLabel: 'Enable symbolic computation tools',
  symbolicEnabledDescription:
    'Symbolic differentiation, simplification, rationalization, LaTeX output and more, based on mathjs',
});
