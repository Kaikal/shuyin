/**
 * Metro 配置：让 workspace 里的共享包（packages/core、theme-engine）能被打包。
 *
 * 关键点：直接指向源码 src/index.ts，而不是包里的 dist 产物——
 * dist 是 ESM 且引用 @babel/runtime 的 helper，Metro 在 workspace 之外解析不到，
 * 会报 "Unable to resolve module @babel/runtime/helpers/interopRequireDefault"。
 * 走源码则由 RN 的 babel preset 统一转译，最稳。
 */
const path = require('path')
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config')

const workspaceRoot = path.resolve(__dirname, '../..')

const aliases = {
  '@shuyin/core': path.join(workspaceRoot, 'packages/core/src/index.ts'),
  '@shuyin/theme-engine': path.join(workspaceRoot, 'packages/theme-engine/src/index.ts'),
}

const config = {
  watchFolders: [workspaceRoot],
  resolver: {
    nodeModulesPaths: [
      path.join(__dirname, 'node_modules'),
      path.join(workspaceRoot, 'node_modules'),
    ],
    extraNodeModules: aliases,
    resolveRequest: (context, moduleName, platform) => {
      const hit = aliases[moduleName]
      if (hit) return { type: 'sourceFile', filePath: hit }
      return context.resolveRequest(context, moduleName, platform)
    },
  },
}

module.exports = mergeConfig(getDefaultConfig(__dirname), config)
