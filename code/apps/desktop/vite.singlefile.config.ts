import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { fileURLToPath } from 'node:url'

/**
 * 便携 Web 版构建：把 JS/CSS 全部内联进单个 index.html，
 * 双击即可运行（无需本地服务器、不受 file:// 的 ES module 限制）。
 * 输出到仓库根 dist/web。
 */
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  resolve: {
    alias: {
      '@shuyin/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
      '@shuyin/theme-engine': fileURLToPath(new URL('../../packages/theme-engine/src/index.ts', import.meta.url)),
      '@shuyin/lx-provider': fileURLToPath(new URL('../../packages/lx-provider/src/index.ts', import.meta.url)),
    },
  },
  build: {
    target: 'chrome110',
    outDir: fileURLToPath(new URL('../../../dist/web', import.meta.url)),
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    minify: 'esbuild',
  },
})
