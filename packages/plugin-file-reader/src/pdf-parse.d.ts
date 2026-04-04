declare module 'pdf-parse' {
  interface PDFInfo {
    PDFFormatVersion?: string;
    IsAcroFormPresent?: boolean;
    [key: string]: unknown;
  }

  interface PDFResult {
    numpages: number;
    numrender: number;
    info: PDFInfo;
    text: string;
    version: string;
  }

  function pdfParse(dataBuffer: Buffer): Promise<PDFResult>;
  export default pdfParse;
}
