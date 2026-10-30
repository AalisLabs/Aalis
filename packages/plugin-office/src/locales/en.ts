import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Office document tools',
  groupSummary: 'Create and edit Word, Excel, PPT and PDF documents',
  outputDirLabel: 'Output directory',
  outputDirDescription: 'Directory documents are saved to (a storage URI, such as workspace:/ or data:/docs).',
  badOutputDir: 'outputDir must be a storage URI (such as workspace:/ or data:/docs), currently “{value}”',
  docxLabel: 'Word documents',
  docxEnabledLabel: 'Enable Word tools',
  xlsxLabel: 'Excel workbooks',
  xlsxEnabledLabel: 'Enable Excel tools',
  pptxLabel: 'PPT presentations',
  pptxEnabledLabel: 'Enable PPT tools',
  pdfLabel: 'PDF documents',
  pdfEnabledLabel: 'Enable PDF tools',
});
