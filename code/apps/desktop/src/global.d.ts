/**
 * 构建期注入的全局量（见 vite.config.ts 的 `define`）。
 *
 * 只放「构建时就能确定、运行时不会变」的东西。别在这里塞配置——
 * 那些走 `lib/settings`。
 */
declare const __APP_VERSION__: string
