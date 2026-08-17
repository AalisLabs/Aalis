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

/** 目录下所有 md 文件名（不含 .md 后缀）。 */
function mdNames(subdir: string): string[] {
  try {
    return readdirSync(join(ROOT, subdir)).filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, ''))
  } catch {
    return []
  }
}

/** 文件名 → 侧栏链接项（标题取自 H1）。 */
function fileItem(subdir: string, name: string) {
  return { text: title(join(ROOT, subdir, `${name}.md`)), link: `/${subdir}/${name}` }
}

function items(subdir: string) {
  return mdNames(subdir).sort().map(name => fileItem(subdir, name))
}

// 巨桶显式二级子组：把 services/plugins 按「功能」拆组，取代字母序平铺。
// services 的分桶沿用 services/README 已有的 7 桶策展；plugins 按功能归类。
// 键=目录，值=[{ text:子组名, files:[文件名(不含 .md)] }]。README 置顶为链接；未列入的文件回落「其它」子组（不丢）。
const SUBGROUPS: Record<string, { text: string; files: string[] }[]> = {
  services: [
    { text: '基础设施', files: ['storage', 'memory', 'vectorstore', 'embedding', 'process', 'code-sandbox'] },
    { text: '消息与平台', files: ['gateway', 'platform', 'message', 'message-archive', 'flow-control'] },
    { text: '智能体核心', files: ['agent', 'llm', 'persona', 'commands', 'session-manager'] },
    { text: '安全与确认', files: ['authority', 'session-confirm'] },
    { text: '工具与媒体', files: ['tools', 'tool-session', 'media', 'asr'] },
    { text: '调度与运维', files: ['workflow', 'cron-engine', 'doctor'] },
    { text: '前端', files: ['webui'] },
  ],
  plugins: [
    { text: '平台适配器', files: ['plugin-adapter-onebot'] },
    { text: '模型与嵌入', files: ['plugin-llm-openai', 'plugin-llm-deepseek', 'plugin-llm-ollama', 'plugin-embedding-openai', 'plugin-embedding-ollama'] },
    { text: '记忆与向量存储', files: ['plugin-memory-sqlite', 'plugin-memory-mongodb', 'plugin-memory-inmemory', 'plugin-memory-vector', 'plugin-memory-summary', 'plugin-vectorstore-lancedb', 'plugin-vectorstore-flat'] },
    { text: '智能体与人设', files: ['plugin-agent', 'plugin-persona', 'plugin-session-manager', 'plugin-subtask', 'plugin-skills', 'plugin-todo-list', 'plugin-prompt-budget', 'plugin-trigger-policy', 'user-relation', 'user-relation-graph'] },
    { text: '工具与 MCP', files: ['plugin-tools', 'plugin-tool-system', 'plugin-tool-browser', 'plugin-tool-search', 'plugin-websearch-serper', 'plugin-tool-code-runner', 'plugin-code-sandbox-os', 'plugin-tool-math', 'plugin-tool-onebot', 'plugin-tool-session', 'plugin-file-reader', 'plugin-office', 'plugin-okx-trading', 'mcp', 'plugin-mcp-client', 'plugin-mcp-server'] },
    { text: '调度、网关与运维', files: ['plugin-scheduler', 'plugin-workflow', 'plugin-gateway', 'plugin-flow-control', 'plugin-commands', 'plugin-cli', 'plugin-authority'] },
    { text: '前端 WebUI', files: ['plugin-webui-server', 'plugin-webui-client'] },
  ],
}

// biome-ignore lint: VitePress 侧栏项为混合联合类型（链接项 | 分组项），此处用宽松类型
type SidebarItem = { text: string; link?: string; collapsed?: boolean; items?: SidebarItem[] }

function group(subdir: string, text: string, collapsed = true): SidebarItem | null {
  const names = mdNames(subdir)
  if (!names.length) return null

  const sub = SUBGROUPS[subdir]
  if (!sub) {
    // 无策展：回落字母序平铺
    return { text, collapsed, items: names.sort().map(n => fileItem(subdir, n)) }
  }

  // 有策展：README 置顶 → 各语义子组 → 未归类回落「其它」（保证不丢文件）
  const claimed = new Set(sub.flatMap(g => g.files))
  const its: SidebarItem[] = []
  if (names.includes('README')) its.push(fileItem(subdir, 'README'))
  for (const g of sub) {
    const present = g.files.filter(n => names.includes(n))
    if (present.length) its.push({ text: g.text, collapsed: true, items: present.map(n => fileItem(subdir, n)) })
  }
  const leftover = names.filter(n => n !== 'README' && !claimed.has(n)).sort()
  if (leftover.length) its.push({ text: '其它', collapsed: true, items: leftover.map(n => fileItem(subdir, n)) })
  return { text, collapsed, items: its }
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

/** nav 落点：优先该区 README（策展索引落地页），否则第一篇。 */
const firstLink = (subdir: string) => {
  const names = mdNames(subdir)
  if (names.includes('README')) return `/${subdir}/README`
  return items(subdir)[0]?.link ?? '/architecture'
}

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
      // 「入门」指向真教程（脚手架上手），不再指 494 行的 architecture 参考页
      { text: '入门', link: firstLink('guide') },
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
