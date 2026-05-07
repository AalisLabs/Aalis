import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/ws': {
        target: 'ws://127.0.0.1:3000',
        ws: true,
      },
      '/api': {
        target: 'http://127.0.0.1:3000',
      },
    },
  },
  build: {
    // 拆分大依赖到独立 chunk，避免单个 bundle 超过 500KB；
    // 配合 App.tsx 里非主路径页面的 React.lazy 实现路由级懒加载。
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react-vendor';
          if (/[\\/]node_modules[\\/]highlight\.js[\\/]/.test(id)) return 'highlight';
          if (/[\\/]node_modules[\\/]katex[\\/]/.test(id)) return 'katex';
          if (/[\\/]node_modules[\\/](react-markdown|remark-[^/\\]+|rehype-[^/\\]+|mdast-util-[^/\\]+|hast-util-[^/\\]+|micromark[^/\\]*|unified|unist-util-[^/\\]+|vfile[^/\\]*|bail|trough|is-plain-obj|character-entities[^/\\]*|decode-named-character-reference|space-separated-tokens|comma-separated-tokens|property-information|html-void-elements|web-namespaces|zwitch|longest-streak|markdown-table|escape-string-regexp|ccount|mdurl|parse-entities)[\\/]/.test(id)) return 'markdown';
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
});
