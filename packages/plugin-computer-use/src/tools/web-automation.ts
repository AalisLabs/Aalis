/**
 * Web 自动化工具
 *
 * 基于 Chrome DevTools Protocol (CDP) 对 Electron/CEF/Chrome 应用进行深度操控：
 * - 完整 DOM 树读取
 * - CSS 选择器查询
 * - 元素交互（点击、输入、滚动）
 * - 任意 JS 执行 / DOM 注入
 *
 * 适合 AX API 无法有效识别内部 UI 的现代 Web 技术应用（QQ、VS Code、Discord 等）。
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { Context } from '@aalis/core';
import { CdpManager, type DomNode } from '../cdp/client.js';

const execFile = promisify(execFileCb);

/** 将 DomNode 树格式化为 AI 友好的文本 */
function formatDomTree(node: DomNode, indent: number = 0): string {
  const pad = '  '.repeat(indent);
  const parts: string[] = [];

  // 构建元素描述行
  let line = `${pad}<${node.tag}`;
  if (node.id) line += `#${node.id}`;
  if (node.className) line += `.${node.className.replace(/\s+/g, '.')}`;

  // 重要属性
  const skipAttrs = new Set(['id', 'class', 'style']);
  for (const [k, v] of Object.entries(node.attributes)) {
    if (skipAttrs.has(k)) continue;
    if (['role', 'aria-label', 'placeholder', 'type', 'name', 'href', 'src', 'data-testid', 'title', 'alt'].includes(k)) {
      const display = v.length > 60 ? v.slice(0, 60) + '…' : v;
      line += ` ${k}="${display}"`;
    }
  }
  line += '>';

  if (node.text) line += ` "${node.text}"`;
  if (node.rect) {
    line += ` @(${Math.round(node.rect.x)},${Math.round(node.rect.y)} ${Math.round(node.rect.width)}x${Math.round(node.rect.height)})`;
  }

  parts.push(line);

  for (const child of node.children) {
    parts.push(formatDomTree(child, indent + 1));
  }

  return parts.join('\n');
}

export function registerWebAutomationTools(ctx: Context, cdpManager: CdpManager): void {

  // ── web_connect ──
  ctx.registerTool({
    safety: 'dangerous',
    authority: 3,
    definition: {
      type: 'function',
      function: {
        name: 'web_connect',
        description:
          '连接到 Electron/CEF/Chrome 应用的 Chrome DevTools Protocol (CDP) 调试端口。\n' +
          '使用场景：\n' +
          '1. 连接已开启调试的应用：直接指定 port\n' +
          '2. 启动应用并开启调试：提供 app_path + port，自动以 --remote-debugging-port 启动\n' +
          '3. 列出可用 target：仅提供 port，不指定 target_id，会列出所有可连接的页面\n\n' +
          '⚠️ 需要目标应用以 --remote-debugging-port=PORT 启动。\n' +
          '常见应用启动方式：\n' +
          '  QQ: /Applications/QQ.app/Contents/MacOS/QQ --remote-debugging-port=9222\n' +
          '  VS Code: code --remote-debugging-port=9223\n' +
          '  Chrome: /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9224',
        parameters: {
          type: 'object',
          properties: {
            port: { type: 'number', description: 'CDP 调试端口（默认 9222）' },
            target_id: { type: 'string', description: '要连接的 target ID（不指定则连接第一个 page 类型的 target）' },
            app_path: {
              type: 'string',
              description: '应用可执行文件路径（提供则自动启动，如 /Applications/QQ.app/Contents/MacOS/QQ）',
            },
            list_only: { type: 'boolean', description: '仅列出可用 target，不连接（默认 false）' },
          },
          required: [],
        },
      },
    },
    handler: async (args) => {
      try {
        const port = (args.port as number) || 9222;
        const targetId = args.target_id as string | undefined;
        const appPath = args.app_path as string | undefined;
        const listOnly = (args.list_only as boolean) || false;

        // 如需启动应用
        if (appPath) {
          try {
            // 后台启动，不等待退出
            const child = require('node:child_process').spawn(
              appPath,
              [`--remote-debugging-port=${port}`],
              { detached: true, stdio: 'ignore' },
            );
            child.unref();
            // 等待应用启动并开放端口
            await waitForPort(port, 8000);
          } catch (err) {
            return JSON.stringify({
              error: `启动应用失败: ${err instanceof Error ? err.message : String(err)}`,
              hint: '请确认应用路径正确且应用支持 --remote-debugging-port 参数',
            });
          }
        }

        // 列出 targets
        let targets;
        try {
          targets = await cdpManager.listTargets(port);
        } catch (err) {
          return JSON.stringify({
            error: `无法连接到端口 ${port}: ${err instanceof Error ? err.message : String(err)}`,
            hint: `请确保目标应用已以 --remote-debugging-port=${port} 启动`,
          });
        }

        if (listOnly) {
          return JSON.stringify({
            port,
            targets: targets.map(t => ({
              id: t.id,
              type: t.type,
              title: t.title,
              url: t.url.length > 100 ? t.url.slice(0, 100) + '…' : t.url,
            })),
          });
        }

        // 自动选择 page 类型的 target
        const connectTargetId = targetId || targets.find(t => t.type === 'page')?.id;
        if (!connectTargetId) {
          return JSON.stringify({
            error: '没有找到 page 类型的 target',
            targets: targets.map(t => ({ id: t.id, type: t.type, title: t.title })),
            hint: '请用 target_id 指定要连接的 target',
          });
        }

        const session = await cdpManager.connect(port, connectTargetId);
        return JSON.stringify({
          ok: true,
          port,
          targetId: session.targetId,
          title: session.targetTitle,
          hint: '已连接。可使用 web_inspect 查看 DOM 结构，web_action 进行交互，web_eval 执行 JS。',
        });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  // ── web_inspect ──
  ctx.registerTool({
    safety: 'safe',
    definition: {
      type: 'function',
      function: {
        name: 'web_inspect',
        description:
          '查看已连接应用的 DOM 结构或查找元素。\n' +
          '两种模式：\n' +
          '1. DOM 树模式（默认）：返回页面 DOM 结构树，包含标签、属性、文本、位置\n' +
          '2. 查询模式：用 CSS 选择器查找匹配的元素列表\n\n' +
          '返回的 CSS 选择器可直接用于 web_action 操作元素。',
        parameters: {
          type: 'object',
          properties: {
            port: { type: 'number', description: 'CDP 连接端口（只有一个连接时可省略）' },
            selector: {
              type: 'string',
              description: 'CSS 选择器。DOM 树模式下指定根元素（默认 "body"），查询模式下搜索匹配元素。',
            },
            mode: {
              type: 'string',
              enum: ['tree', 'query'],
              description: '"tree"=DOM 树（默认），"query"=选择器查询',
            },
            depth: { type: 'number', description: 'DOM 树深度（默认 4，建议 2-6）' },
          },
          required: [],
        },
      },
    },
    handler: async (args) => {
      try {
        const port = args.port as number | undefined;
        const selector = (args.selector as string) || 'body';
        const mode = (args.mode as string) || 'tree';
        const depth = (args.depth as number) || 4;

        if (mode === 'query') {
          const elements = await cdpManager.querySelectorAll(port, selector);
          return JSON.stringify({
            selector,
            matchCount: elements.length,
            elements: elements.slice(0, 50), // 限制返回数量
            hint: elements.length > 50 ? `共 ${elements.length} 个匹配，仅显示前 50 个。请用更精确的选择器缩小范围。` : undefined,
          });
        }

        // DOM 树模式
        const tree = await cdpManager.getDomTree(port, selector, depth);
        const summary = tree.map(n => formatDomTree(n)).join('\n\n');
        return JSON.stringify({
          selector,
          depth,
          summary,
          hint: '使用 web_action(selector, action) 操作元素，或 web_inspect(selector, mode="query") 精确查找。',
        });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  // ── web_action ──
  ctx.registerTool({
    safety: 'dangerous',
    authority: 3,
    definition: {
      type: 'function',
      function: {
        name: 'web_action',
        description:
          '在已连接应用中对 DOM 元素执行交互操作。\n' +
          '支持的操作：\n' +
          '- click: 点击元素\n' +
          '- type: 在输入框中输入文本\n' +
          '- scroll: 在元素上滚动\n' +
          '- focus: 聚焦元素\n\n' +
          '使用 CSS 选择器定位元素（如 "#send-btn", ".message-input", "[data-testid=login]"）。',
        parameters: {
          type: 'object',
          properties: {
            port: { type: 'number', description: 'CDP 连接端口（只有一个连接时可省略）' },
            selector: { type: 'string', description: '目标元素的 CSS 选择器' },
            action: {
              type: 'string',
              enum: ['click', 'type', 'scroll', 'focus'],
              description: '要执行的操作',
            },
            text: { type: 'string', description: '输入文本（action=type 时必填）' },
            clear: { type: 'boolean', description: '输入前是否清空（action=type，默认 true）' },
            scroll_x: { type: 'number', description: '水平滚动量（action=scroll，正值向右）' },
            scroll_y: { type: 'number', description: '垂直滚动量（action=scroll，正值向下，默认 -300=向下滚动一段）' },
          },
          required: ['selector', 'action'],
        },
      },
    },
    handler: async (args) => {
      try {
        const port = args.port as number | undefined;
        const selector = args.selector as string;
        const action = args.action as string;

        switch (action) {
          case 'click': {
            const pos = await cdpManager.clickElement(port, selector);
            return JSON.stringify({ ok: true, action: 'click', selector, clickedAt: pos });
          }
          case 'type': {
            const text = args.text as string;
            if (!text) return JSON.stringify({ error: 'action=type 时必须提供 text 参数' });
            const clear = (args.clear as boolean) ?? true;
            await cdpManager.typeInElement(port, selector, text, clear);
            return JSON.stringify({ ok: true, action: 'type', selector, length: text.length, cleared: clear });
          }
          case 'scroll': {
            const deltaX = (args.scroll_x as number) || 0;
            const deltaY = (args.scroll_y as number) || -300;
            await cdpManager.scrollElement(port, selector, deltaX, deltaY);
            return JSON.stringify({ ok: true, action: 'scroll', selector, deltaX, deltaY });
          }
          case 'focus': {
            const session = cdpManager.requireSession(port);
            const { client } = session;
            const { root } = await client.DOM.getDocument({ depth: 0 });
            const { nodeId } = await client.DOM.querySelector({ nodeId: root.nodeId, selector });
            if (!nodeId) return JSON.stringify({ error: `未找到匹配 "${selector}" 的元素` });
            await client.DOM.focus({ nodeId });
            return JSON.stringify({ ok: true, action: 'focus', selector });
          }
          default:
            return JSON.stringify({ error: `未知操作: ${action}`, supported: ['click', 'type', 'scroll', 'focus'] });
        }
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  // ── web_eval ──
  ctx.registerTool({
    safety: 'dangerous',
    authority: 5,
    definition: {
      type: 'function',
      function: {
        name: 'web_eval',
        description:
          '在已连接应用的页面上下文中执行 JavaScript 代码。\n' +
          '功能强大，可实现：\n' +
          '- 读取页面数据（DOM 内容、变量、localStorage 等）\n' +
          '- 修改页面（注入元素、修改样式、拦截事件）\n' +
          '- 调用页面内的函数和 API\n' +
          '- 执行异步操作（支持 await）\n\n' +
          '⚠️ 高权限操作，可完全控制页面上下文。',
        parameters: {
          type: 'object',
          properties: {
            port: { type: 'number', description: 'CDP 连接端口（只有一个连接时可省略）' },
            code: { type: 'string', description: '要执行的 JavaScript 代码' },
          },
          required: ['code'],
        },
      },
    },
    handler: async (args) => {
      try {
        const port = args.port as number | undefined;
        const code = args.code as string;
        const result = await cdpManager.evaluate(port, code);
        return JSON.stringify({ ok: true, result });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });
}

// ──────────── 辅助函数 ────────────

/** 等待端口可用 */
async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const net = await import('node:net');
      await new Promise<void>((resolve, reject) => {
        const sock = net.createConnection({ port, host: '127.0.0.1' }, () => {
          sock.destroy();
          resolve();
        });
        sock.on('error', reject);
        sock.setTimeout(500, () => {
          sock.destroy();
          reject(new Error('timeout'));
        });
      });
      return;
    } catch {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error(`等待端口 ${port} 超时 (${timeoutMs}ms)`);
}
