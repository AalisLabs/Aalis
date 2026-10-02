import { BUILTIN_THEMES, parseTheme } from '@aalis/api-webui';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * 内置主题：每个主题文件经 parseTheme 校验后写成一条按 <html data-theme> 取值的规则，内联进页面头部，
 * 页面第一帧就有颜色。首帧主题脚本（public/theme.js）紧跟在规则后面，写上 data-theme，选中的主题没有规则时换成默认的
 */
function builtinThemes(): Plugin {
  const rules = Object.entries(BUILTIN_THEMES).map(([id, file]) => {
    const parsed = parseTheme(file);
    if (!parsed.ok) throw new Error(`内置主题 ${id} 不合主题文件的格式：${parsed.errors.join('；')}`);
    const declarations = Object.entries(parsed.theme.colors).map(([token, value]) => `${token}:${value}`);
    return `:root[data-theme="${id}"]{color-scheme:${parsed.theme.kind};${declarations.join(';')}}`;
  });
  return {
    name: 'aalis-builtin-themes',
    transformIndexHtml: () => [
      { tag: 'style', children: rules.join('\n'), injectTo: 'head' },
      { tag: 'script', attrs: { src: '/theme.js' }, injectTo: 'head' },
    ],
  };
}

export default defineConfig({
  plugins: [react(), builtinThemes()],
  server: {
    proxy: {
      '/session': {
        target: 'ws://127.0.0.1:3000',
        ws: true,
      },
      '/admin': {
        target: 'ws://127.0.0.1:3000',
        ws: true,
      },
      '/api': {
        target: 'http://127.0.0.1:3000',
      },
    },
  },
  build: {
    // 浏览器下限：近两年的 Chrome、Edge、Firefox，Safari 16 起
    target: ['chrome117', 'edge117', 'firefox118', 'safari16'],
    // 资源一律是同源的文件，不内联成 data: 地址：文档级 CSP 的 font-src 随 default-src 只许同源，内联的公式字体会被拦下
    assetsInlineLimit: 0,
    // 拆分大依赖到独立 chunk，避免单个 bundle 超过 500KB
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react-vendor';
          if (/[\\/]node_modules[\\/]highlight\.js[\\/]/.test(id)) return 'highlight';
          if (/[\\/]node_modules[\\/]katex[\\/]/.test(id)) return 'katex';
          if (
            /[\\/]node_modules[\\/](react-markdown|remark-[^/\\]+|rehype-[^/\\]+|mdast-util-[^/\\]+|hast-util-[^/\\]+|micromark[^/\\]*|unified|unist-util-[^/\\]+|vfile[^/\\]*|bail|trough|is-plain-obj|character-entities[^/\\]*|decode-named-character-reference|space-separated-tokens|comma-separated-tokens|property-information|html-void-elements|web-namespaces|zwitch|longest-streak|markdown-table|escape-string-regexp|ccount|mdurl|parse-entities)[\\/]/.test(
              id,
            )
          )
            return 'markdown';
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
});
