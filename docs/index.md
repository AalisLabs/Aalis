---
layout: home
hero:
  name: Aalis
  text: 可扩展的 LLM 聊天机器人框架
  tagline: 接入 QQ 等平台，按需装插件，接你想用的大模型——一行命令起一个自己的 bot，数据留在自己机器上。
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
    details: OpenAI / Claude / DeepSeek / 本地 Ollama 等随意切换，甚至每个会话各用各的。
  - title: 自托管私有部署
    details: 一行命令起一个独立项目，自己的机器、自己的数据，不依赖任何托管服务。
---

## 快速上手

一行命令，起一个能跑的机器人项目：

```bash
npm create aalis my-bot
```

进入目录，在 `aalis.config.yaml` 里填好大模型 API 与平台账号，启动即可。
完整步骤（配置、装插件、部署）见 [脚手架上手指南](/guide/scaffolding)。
