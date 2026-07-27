import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import { readdirSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'

// 文档根 = site/（config 在 site/.vitepress/）。副本预览，真仓 docs/ 不受影响。
const ROOT = join(import.meta.dirname, '..')

/** 读一篇 md 的首个 H1 作为侧栏标题，读不到回落文件名。 */
function title(abs: string): string {
  try {
    const m = readFileSync(abs, 'utf-8').match(/^#\s+(.+?)\s*$/m)
    return m ? m[1].replace(/[`*_]/g, '') : basename(abs, '.md')
  } catch {
    return basename(abs, '.md')
  }
}

function items(subdir: string) {
  const dir = join(ROOT, subdir)
  let files: string[] = []
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.md'))
  } catch {
    return []
  }
  return files.sort().map(f => ({ text: title(join(dir, f)), link: `/${subdir}/${f.replace(/\.md$/, '')}` }))
}

function group(subdir: string, text: string, collapsed = true) {
  const its = items(subdir)
  return its.length ? { text, collapsed, items: its } : null
}

/** 根级 md（architecture.md / plugin-author-guide.md）作为「概览」组，index.md 除外 */
function rootItems() {
  let files: string[] = []
  try {
    files = readdirSync(ROOT).filter(f => f.endsWith('.md') && f !== 'index.md')
  } catch {
    return []
  }
  return files.sort().map(f => ({ text: title(join(ROOT, f)), link: `/${f.replace(/\.md$/, '')}` }))
}

/** 所有顶层目录 —— 新增文件夹会被自动扫到，无需改配置 */
function allDirs(): string[] {
  try {
    return readdirSync(ROOT, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'public')
      .map(d => d.name)
  } catch {
    return []
  }
}

// 目录 → 中文标签 + 顺序。未列出的目录仍会自动出现（标签回落为目录名，排在已知目录之后）。
const GROUP_LABELS: Record<string, string> = {
  guide: '入门',
  concepts: '概念',
  core: '核心',
  services: '服务',
  plugins: '插件',
  api: 'API 契约',
  design: '设计',
  utils: '工具库',
  extensions: '扩展',
  architecture: '架构',
  roadmap: '规划与已知问题',
}
const ORDER = ['guide', 'concepts', 'core', 'services', 'plugins', 'api', 'design', 'utils', 'extensions', 'roadmap']
const COLLAPSED = new Set(['services', 'plugins', 'api', 'design', 'utils', 'extensions', 'architecture', 'roadmap'])

const dirs = allDirs()
const orderedDirs = [...ORDER.filter(d => dirs.includes(d)), ...dirs.filter(d => !ORDER.includes(d)).sort()]

const sidebar = [
  { text: '概览', items: rootItems() },
  ...orderedDirs.map(d => group(d, GROUP_LABELS[d] ?? d, COLLAPSED.has(d))),
].filter(Boolean)

const firstLink = (subdir: string) => items(subdir)[0]?.link ?? '/architecture'

export default withMermaid(defineConfig({
  title: 'Aalis',
  description: '忒修斯之船式的 LLM 助手框架 — 极简内核，万物皆插件',
  lang: 'zh-CN',
  cleanUrls: true,
  markdown: {
    // 行内代码统一 v-pre：Vue 跳过编译，`{{ }}` 与 <Tag> 原样显示。
    // 根治「行内代码里的 {{outputs.<out>}} 被当插值解析而 build 失败」——零文档改动。
    config(md) {
      md.renderer.rules.code_inline = (tokens, idx) =>
        `<code v-pre>${md.utils.escapeHtml(tokens[idx].content)}</code>`
    },
  },
  themeConfig: {
    siteTitle: false,
    nav: [
      { text: '入门', link: '/architecture' },
      { text: '核心', link: firstLink('core') },
      { text: '服务', link: firstLink('services') },
      { text: '插件', link: firstLink('plugins') },
      { text: 'API', link: firstLink('api') },
    ],
    sidebar,
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: 'https://github.com/AalisLabs/Aalis' }],
    outline: { label: '本页目录', level: [2, 3] },
    docFooter: { prev: '上一页', next: '下一页' },
    darkModeSwitchLabel: '外观',
    lightModeSwitchTitle: '切换到浅色',
    darkModeSwitchTitle: '切换到深色',
    sidebarMenuLabel: '菜单',
    returnToTopLabel: '回到顶部',
    langMenuLabel: '语言',
    footer: {
      message:
        '基于 <a href="https://github.com/AalisLabs/Aalis/blob/main/LICENSE" target="_blank" rel="noreferrer">MIT 许可</a>发布',
      copyright:
        'Copyright © 2026 <a href="https://github.com/AalisLabs/Aalis" target="_blank" rel="noreferrer">Ace Nyan</a>',
    },
  },
  mermaid: {
    theme: 'base',
    themeVariables: {
      fontSize: '15px',
      primaryColor: '#efeaff',
      primaryBorderColor: '#7c4dff',
      primaryTextColor: '#211c33',
      lineColor: '#e79c00',
      secondaryColor: '#fdf1d6',
    },
    // padding/间距拉大，修 CJK 多行标签上下被裁；htmlLabels 保证 <br/> 正常换行
    flowchart: { padding: 16, nodeSpacing: 46, rankSpacing: 50, htmlLabels: true },
  },
}))
