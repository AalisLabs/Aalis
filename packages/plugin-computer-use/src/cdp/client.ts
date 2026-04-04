/**
 * Chrome DevTools Protocol 连接管理器
 *
 * 管理与 Electron/CEF/Chrome 应用的 CDP 连接。
 * 支持：
 * - 连接到已有调试端口
 * - 自动发现可用 target
 * - 连接多个应用（按 port 区分）
 */

import CDP from 'chrome-remote-interface';

// ──────────── 类型 ────────────

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
}

export interface CdpSession {
  port: number;
  client: CDP.Client;
  targetId: string;
  targetTitle: string;
}

export interface DomNode {
  nodeId: number;
  tag: string;
  id?: string;
  className?: string;
  text?: string;
  attributes: Record<string, string>;
  rect?: { x: number; y: number; width: number; height: number };
  children: DomNode[];
  path: string;
}

// ──────────── 管理器 ────────────

/**
 * 管理多个 CDP 连接，按端口号索引。
 */
export class CdpManager {
  private sessions = new Map<number, CdpSession>();

  /** 列出指定端口上的所有可用 target */
  async listTargets(port: number, host = '127.0.0.1'): Promise<CdpTarget[]> {
    const targets = await CDP.List({ host, port });
    return targets.map((t: any) => ({
      id: t.id,
      type: t.type,
      title: t.title,
      url: t.url,
    }));
  }

  /** 连接到指定端口的 CDP target */
  async connect(port: number, targetId?: string, host = '127.0.0.1'): Promise<CdpSession> {
    // 如果已有连接，先关闭
    await this.disconnect(port);

    const cdpOptions: CDP.Options = { host, port };
    if (targetId) cdpOptions.target = targetId;

    const client: CDP.Client = await CDP(cdpOptions);
    await Promise.all([
      client.DOM.enable(),
      client.Runtime.enable(),
      client.Page.enable(),
    ]);

    const { targetInfo } = await client.Target.getTargetInfo();

    const session: CdpSession = {
      port,
      client,
      targetId: targetInfo.targetId,
      targetTitle: targetInfo.title,
    };
    this.sessions.set(port, session);
    return session;
  }

  /** 断开指定端口的连接 */
  async disconnect(port: number): Promise<void> {
    const session = this.sessions.get(port);
    if (session) {
      try {
        await session.client.close();
      } catch {
        // 忽略关闭错误
      }
      this.sessions.delete(port);
    }
  }

  /** 断开所有连接 */
  async disconnectAll(): Promise<void> {
    for (const port of this.sessions.keys()) {
      await this.disconnect(port);
    }
  }

  /** 获取已连接的会话 */
  getSession(port: number): CdpSession | undefined {
    return this.sessions.get(port);
  }

  /** 获取当前唯一会话（仅有一个连接时） */
  getDefaultSession(): CdpSession | undefined {
    if (this.sessions.size === 1) {
      return this.sessions.values().next().value!;
    }
    return undefined;
  }

  /** 按端口号获取或抛错 */
  requireSession(port?: number): CdpSession {
    if (port !== undefined) {
      const s = this.sessions.get(port);
      if (!s) throw new Error(`端口 ${port} 没有活跃的 CDP 连接。请先使用 web_connect 连接。`);
      return s;
    }
    const s = this.getDefaultSession();
    if (!s) {
      if (this.sessions.size === 0) {
        throw new Error('没有活跃的 CDP 连接。请先使用 web_connect 连接目标应用。');
      }
      throw new Error(
        `有多个活跃连接 (端口: ${[...this.sessions.keys()].join(', ')})，请通过 port 参数指定要操作的连接。`,
      );
    }
    return s;
  }

  /** 列出所有活跃连接 */
  listConnections(): Array<{ port: number; targetId: string; targetTitle: string }> {
    return [...this.sessions.values()].map(s => ({
      port: s.port,
      targetId: s.targetId,
      targetTitle: s.targetTitle,
    }));
  }

  // ──────────── DOM 操作 ────────────

  /** 获取 DOM 树 */
  async getDomTree(port: number | undefined, selector: string, depth: number): Promise<DomNode[]> {
    const session = this.requireSession(port);
    const { client } = session;

    // 获取文档根节点
    const { root } = await client.DOM.getDocument({ depth: 0 });

    let targetNodeId: number;
    if (selector === 'body' || selector === '') {
      // 查找 body
      const { nodeId } = await client.DOM.querySelector({ nodeId: root.nodeId, selector: 'body' });
      targetNodeId = nodeId;
    } else {
      const { nodeId } = await client.DOM.querySelector({ nodeId: root.nodeId, selector });
      if (!nodeId) throw new Error(`未找到匹配 "${selector}" 的元素`);
      targetNodeId = nodeId;
    }

    // 请求子树
    await client.DOM.requestChildNodes({ nodeId: targetNodeId, depth });

    // 等待一小段时间让 setChildNodes 事件填充
    await new Promise(r => setTimeout(r, 200));

    // 重新获取带子节点的文档
    const { root: fullRoot } = await client.DOM.getDocument({ depth: depth + 2 });
    const targetInFull = this.findNodeById(fullRoot, targetNodeId);
    if (!targetInFull) throw new Error('无法获取 DOM 子树');

    return [await this.convertNode(client, targetInFull, '', 0, depth)];
  }

  /** 查询匹配选择器的所有元素 */
  async querySelectorAll(
    port: number | undefined,
    selector: string,
  ): Promise<Array<{ tag: string; id?: string; className?: string; text?: string; path: string; rect?: any }>> {
    const session = this.requireSession(port);
    const { client } = session;

    const { root } = await client.DOM.getDocument({ depth: 0 });
    const { nodeIds } = await client.DOM.querySelectorAll({ nodeId: root.nodeId, selector });

    const results: Array<any> = [];
    for (const nodeId of nodeIds) {
      try {
        const { node } = await client.DOM.describeNode({ nodeId, depth: 0 });
        const tag = (node.localName || node.nodeName || '').toLowerCase();
        const attrs = this.parseAttributes(node.attributes || []);

        // 获取文本
        let text: string | undefined;
        try {
          const { object } = await client.DOM.resolveNode({ nodeId });
          if (object.objectId) {
            const { result } = await client.Runtime.callFunctionOn({
              objectId: object.objectId,
              functionDeclaration: 'function() { return this.innerText?.slice(0, 200); }',
              returnByValue: true,
            });
            text = result.value;
          }
        } catch {
          // 忽略
        }

        // 获取位置
        let rect: any;
        try {
          const boxResult = await client.DOM.getBoxModel({ nodeId });
          const q = boxResult.model.content;
          rect = { x: q[0], y: q[1], width: q[2] - q[0], height: q[5] - q[1] };
        } catch {
          // 元素可能不可见
        }

        results.push({
          tag,
          id: attrs.id,
          className: attrs.class,
          text,
          path: `${tag}${attrs.id ? '#' + attrs.id : ''}${attrs.class ? '.' + attrs.class.split(' ')[0] : ''}`,
          rect,
        });
      } catch {
        // 跳过无法描述的节点
      }
    }
    return results;
  }

  // ──────────── 交互操作 ────────────

  /** 点击元素 */
  async clickElement(port: number | undefined, selector: string): Promise<{ x: number; y: number }> {
    const session = this.requireSession(port);
    const { client } = session;

    const center = await this.getElementCenter(client, selector);
    await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: center.x, y: center.y, button: 'left', clickCount: 1 });
    await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: center.x, y: center.y, button: 'left', clickCount: 1 });
    return center;
  }

  /** 在元素中输入文本 */
  async typeInElement(port: number | undefined, selector: string, text: string, clear: boolean): Promise<void> {
    const session = this.requireSession(port);
    const { client } = session;

    // 聚焦元素
    const { root } = await client.DOM.getDocument({ depth: 0 });
    const { nodeId } = await client.DOM.querySelector({ nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`未找到匹配 "${selector}" 的元素`);
    await client.DOM.focus({ nodeId });

    // 清空
    if (clear) {
      await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'a', commands: ['selectAll'] });
      await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'a' });
      await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Backspace', code: 'Backspace' });
      await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Backspace', code: 'Backspace' });
    }

    // 逐字输入
    for (const char of text) {
      await client.Input.dispatchKeyEvent({ type: 'keyDown', text: char, key: char });
      await client.Input.dispatchKeyEvent({ type: 'keyUp', key: char });
    }
  }

  /** 滚动元素 */
  async scrollElement(port: number | undefined, selector: string, deltaX: number, deltaY: number): Promise<void> {
    const session = this.requireSession(port);
    const { client } = session;

    const center = await this.getElementCenter(client, selector);
    await client.Input.dispatchMouseEvent({
      type: 'mouseWheel',
      x: center.x,
      y: center.y,
      deltaX,
      deltaY,
    });
  }

  /** 执行 JavaScript */
  async evaluate(port: number | undefined, expression: string): Promise<any> {
    const session = this.requireSession(port);
    const { client } = session;

    const { result, exceptionDetails } = await client.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: true,
    });

    if (exceptionDetails) {
      throw new Error(exceptionDetails.text || exceptionDetails.exception?.description || 'JS 执行错误');
    }
    return result.value;
  }

  // ──────────── 私有辅助 ────────────

  private async getElementCenter(client: CDP.Client, selector: string): Promise<{ x: number; y: number }> {
    const { root } = await client.DOM.getDocument({ depth: 0 });
    const { nodeId } = await client.DOM.querySelector({ nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`未找到匹配 "${selector}" 的元素`);

    const { model } = await client.DOM.getBoxModel({ nodeId });
    const q = model.content;
    return {
      x: (q[0] + q[2]) / 2,
      y: (q[1] + q[5]) / 2,
    };
  }

  private findNodeById(node: any, targetId: number): any {
    if (node.nodeId === targetId) return node;
    for (const child of node.children || []) {
      const found = this.findNodeById(child, targetId);
      if (found) return found;
    }
    return null;
  }

  private async convertNode(client: CDP.Client, node: any, parentPath: string, currentDepth: number, maxDepth: number): Promise<DomNode> {
    const tag = (node.localName || node.nodeName || '').toLowerCase();
    const attrs = this.parseAttributes(node.attributes || []);

    // 构建路径
    const pathPart = `${tag}${attrs.id ? '#' + attrs.id : ''}`;
    const path = parentPath ? `${parentPath} > ${pathPart}` : pathPart;

    // 获取文本内容（仅文本节点）
    let text: string | undefined;
    if (node.nodeType === 3 /* TEXT_NODE */) {
      text = node.nodeValue?.trim();
    } else if (node.children?.length === 1 && node.children[0].nodeType === 3) {
      text = node.children[0].nodeValue?.trim();
    }

    // 获取位置
    let rect: DomNode['rect'];
    try {
      if (node.nodeId && tag && tag !== '#document' && tag !== '#text') {
        const boxResult = await client.DOM.getBoxModel({ nodeId: node.nodeId });
        const q = boxResult.model.content;
        rect = { x: q[0], y: q[1], width: q[2] - q[0], height: q[5] - q[1] };
      }
    } catch {
      // 元素不可见
    }

    // 递归子节点
    const children: DomNode[] = [];
    if (currentDepth < maxDepth && node.children) {
      for (const child of node.children) {
        // 跳过纯文本节点和脚本/样式
        const childTag = (child.localName || child.nodeName || '').toLowerCase();
        if (child.nodeType === 3 || childTag === 'script' || childTag === 'style' || childTag === 'link') continue;

        children.push(await this.convertNode(client, child, path, currentDepth + 1, maxDepth));
      }
    }

    return {
      nodeId: node.nodeId,
      tag,
      id: attrs.id,
      className: attrs.class,
      text: text ? (text.length > 100 ? text.slice(0, 100) + '…' : text) : undefined,
      attributes: attrs,
      rect,
      children,
      path,
    };
  }

  private parseAttributes(attrList: string[]): Record<string, string> {
    const attrs: Record<string, string> = {};
    for (let i = 0; i < attrList.length; i += 2) {
      attrs[attrList[i]] = attrList[i + 1];
    }
    return attrs;
  }
}
