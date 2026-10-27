import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// Tauri 期望固定端口，失败则退出而不是换端口
const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shuyin/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
      '@shuyin/theme-engine': fileURLToPath(new URL('../../packages/theme-engine/src/index.ts', import.meta.url)),
      '@shuyin/lx-provider': fileURLToPath(new URL('../../packages/lx-provider/src/index.ts', import.meta.url)),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    target: 'chrome110',
    minify: 'esbuild',
    sourcemap: false,
    // 五个窗口五个入口：主窗口 index.html / 桌面歌词 lyrics.html /
    // 音乐桌面 musicdesk.html / 音乐锁屏 musiclock.html / 托盘菜单 tray.html
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('index.html', import.meta.url)),
        lyrics: fileURLToPath(new URL('lyrics.html', import.meta.url)),
        musicdesk: fileURLToPath(new URL('musicdesk.html', import.meta.url)),
        musiclock: fileURLToPath(new URL('musiclock.html', import.meta.url)),
        tray: fileURLToPath(new URL('tray.html', import.meta.url)),
      },
    },
  },
})
