import { createBoundedMap } from '@aalis/util-bounded-map';

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
  // 有界：max 50 + 30min 滑动 TTL（每次 get/require/getByType 刷新存活）。
  // 活跃文档（持续 add → 持续 get）不会被逐出；只清理 >30min 未操作的废弃（创建后从未 save）会话。
  private sessions = createBoundedMap<string, DocSession>({ max: 50, ttlMs: 30 * 60 * 1000 });

  create(type: DocType, filename: string, doc: unknown): string {
    const id = `doc-${crypto.randomUUID().slice(0, 8)}`;
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

  /** 清空所有会话（插件卸载/热重载时由 onDispose 调用）。 */
  clear(): void {
    this.sessions.clear();
  }

  list(): DocSession[] {
    return this.sessions.values();
  }

  /** 获取会话或抛出错误（简化工具代码） */
  require(id: string, expectedType?: DocType): DocSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`文档不存在或已过期（超 30 分钟未操作会自动释放）；请重新 create: ${id}`);
    if (expectedType && session.type !== expectedType) {
      throw new Error(`文档类型不匹配: 期望 ${expectedType}，实际 ${session.type}`);
    }
    return session;
  }
}
