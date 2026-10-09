---
layout: home
hero:
  name: Aalis
  text: 可扩展的插件化框架
  tagline: 当下主场是 LLM Agent / Bot 混合，但不止于此。
  actions:
    - theme: brand
      text: 快速上手
      link: /guide/scaffolding
    - theme: alt
      text: 架构总览
      link: /architecture
    - theme: alt
      text: GitHub
      link: https://github.com/AalisLabs/Aalis
features:
  - title: 多平台接入
    details: OneBot（QQ）、WebUI、CLI 开箱即用；适配器本身也是插件，可再接更多平台。
  - title: 按需装插件
    details: 聊天、记忆、工具调用、定时任务、联网搜索……想要什么装什么，不用的不占地方。
  - title: 接多家大模型
    details: OpenAI / DeepSeek / 本地 Ollama 开箱即用，任何 OpenAI 兼容端点都能接；甚至每个会话各用各的。
  - title: 自托管私有部署
    details: 一行命令起一个独立项目，自己的机器、自己的数据，不依赖任何托管服务。
---

## 快速上手

一行命令，起一个能跑的机器人项目：

```bash
npm create aalis@latest my-bot
```

脚手架问对话模型（可当场粘贴 key）、接入平台与要不要长期语义记忆，装好依赖后进入目录 `npm start` 即可；本机在跑 Ollama 时默认用它，不要任何 key。`home/` 是这个实例的家目录，配置、数据与日志都在里面，已写进生成的 `.gitignore`。
建项目的完整步骤见 [脚手架上手指南](/guide/scaffolding)；启动之后怎么用（要准备什么、没起来的插件怎么看、CLI 与 WebUI 两个入口）见 [第一次运行](/guide/first-run)；装不上或起不来见 [安装与启动排障](/guide/troubleshooting)。
