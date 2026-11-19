import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

/** 只在正式构建里注入内容安全策略（开发时 Vite 的热更新需要内联脚本）。 */
function cspPlugin(): Plugin {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
  ].join('; ');
  return {
    name: 'auto-adv-csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`),
  };
}

export default defineConfig({
  main: {
    build: {
      // 所有依赖都打进包里，安装包不需要 node_modules
      externalizeDeps: false,
      rolldownOptions: {
        // node:sqlite 只有带前缀的写法，不在 builtinModules 列表里，需要手动声明
        external: ['node:sqlite'],
        input: {
          index: resolve('src/main/index.ts'),
          engine: resolve('src/engine/index.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
    },
  },
  renderer: {
    plugins: [react(), tailwindcss(), cspPlugin()],
    build: {
      minify: true,
    },
  },
});
