import DefaultTheme from 'vitepress/theme'
import { h } from 'vue'
import Wordmark from './Wordmark.vue'
import './custom.css'

// 用主题插槽把顶栏站名替换成定制字标（紫 A + 金点）。
// 配合 config.themeConfig.siteTitle = false 隐藏默认文本，避免重复。
export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'nav-bar-title-before': () => h(Wordmark),
    })
  },
}
