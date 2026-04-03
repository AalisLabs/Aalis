import { randomUUID } from 'node:crypto';

export type DocType = 'docx' | 'xlsx' | 'pptx' | 'pdf';

export interface DocSession {
  id: string;
  type: DocType;
  filename: string;
  /** 底层文档对象（docx.Document / ExcelJS.Workbook / pptxgen） */
  doc: unknown;
  createdAt: number;
}

/**
 * 管理内存中的文档会话。
 * create 返回 docId，后续操作引用该 ID，save 后释放。
 */
export class DocSessionManager {
  private sessions = new Map<string, DocSession>();

  create(type: DocType, filename: string, doc: unknown): string {
    const id = `doc-${randomUUID().slice(0, 8)}`;
    this.sessions.set(id, { id, type, filename, doc, createdAt: Date.now() });
    return id;
  }

  get(id: string): DocSession | undefined {
    return this.sessions.get(id);
  }

  getByType<T>(id: string, type: DocType): T | undefined {
    const session = this.sessions.get(id);
    if (!session || session.type !== type) return undefined;
    return session.doc as T;
  }

  remove(id: string): boolean {
    return this.sessions.delete(id);
  }

  list(): DocSession[] {
    return [...this.sessions.values()];
  }

  /** 获取会话或抛出错误（简化工具代码） */
  require(id: string, expectedType?: DocType): DocSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`文档不存在: ${id}`);
    if (expectedType && session.type !== expectedType) {
      throw new Error(`文档类型不匹配: 期望 ${expectedType}，实际 ${session.type}`);
    }
    return session;
  }
}
