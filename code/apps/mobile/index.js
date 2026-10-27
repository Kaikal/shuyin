/**
 * 移动端入口：注册播放服务（UI 卸载后后台事件仍可处理）+ 启动 Metro。
 */
import { AppRegistry } from 'react-native'
import { App } from './src/App'
import { registerPlaybackService } from './src/lib/player'
import { name as appName } from './app.json'

void registerPlaybackService()
AppRegistry.registerComponent(appName, () => App)
