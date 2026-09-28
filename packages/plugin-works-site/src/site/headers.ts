import { galleryHeaders, workHeaders } from '@aalis/api-publish';

function render(headers: Record<string, string>): string {
  const lines = [
    '/*',
    ...Object.entries(headers).map(([key, value]) => (key.startsWith('! ') ? `  ${key}` : `  ${key}: ${value}`)),
  ];
  if (lines.some(line => line.length > 2000)) throw new TypeError('_headers 行超过 2000 字符');
  return `${lines.join('\n')}\n`;
}

export function galleryHeaderFile(frameOrigins: readonly string[]): string {
  return render({
    ...galleryHeaders({ frameOrigins }),
    'X-Robots-Tag': 'noarchive, noimageindex',
    '! Access-Control-Allow-Origin': '',
  });
}

export function branchHeaderFile(frameAncestors: readonly string[]): string {
  return render(workHeaders({ scope: 'self', frameAncestors }));
}
