# 入门

从零跑起一个 Aalis 实例，或写一个可发布的插件。

| 篇目 | 讲什么 |
|---|---|
| [脚手架上手指南](./scaffolding.md) | `npm create aalis` 建项目：问什么、`--advanced` 与模板档、Ollama 探测、生成了什么、配置约定；以及 `create-aalis-plugin` 建插件骨架（依赖写法、工具的风险档位、会话设置项） |
| [第一次运行](./first-run.md) | 启动之后：要准备什么、零 key 怎么起、CLI 与 WebUI 两个入口、「开始使用」与「需要处理」、发第一条消息、换模型、停止与数据位置 |
| [安装与启动排障](./troubleshooting.md) | Node 版本、`npm install` 失败的各类原因与修法、端口被占、token 在哪、`/doctor` 与日志、卸载后留下的配置段、Intel Mac 与 LanceDB |
| [记忆由哪些插件组成](./memory.md) | 消息存储、摘要与画像、语义记忆三层各要什么，服务是什么，缺一环时界面怎么显示 |
| [第三方插件开发者指南](./third-party-plugin.md) | 从零到发布：`definePlugin`、消费/提供服务、扩展点、两套元数据、发布到插件市场 |

## 接着读

- 写插件前应通读的心智模型：[概念](../concepts/README.md)
- 内核 API：[核心](../core/README.md)
- 部署与运行时（能不能用 pnpm、非 TTY 行为）：[@aalis/runtime](../architecture/runtime.md)
