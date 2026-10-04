import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/** 管理面 REST 的契约文件 */
export const CONTRACT_FILE = join(import.meta.dirname, '../../packages/api-webui/src/rest.ts');

/** 契约的路由表：回 JSON 的与回文件的，各自的键按写的先后 */
export function contractRoutes(): { json: string[]; file: string[] } {
  const source = ts.createSourceFile(CONTRACT_FILE, readFileSync(CONTRACT_FILE, 'utf-8'), ts.ScriptTarget.Latest, true);
  const keysOf = (name: string) => {
    const table = source.statements.find(
      (statement): statement is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(statement) && statement.name.text === name,
    );
    if (!table) throw new Error(`契约里没有 ${name}`);
    return table.members.map(member => {
      if (!member.name || !ts.isStringLiteral(member.name)) throw new Error(`${name} 的键要写成字符串字面量`);
      return member.name.text;
    });
  };
  return { json: keysOf('WebuiRestRoutes'), file: keysOf('WebuiFileRoutes') };
}
