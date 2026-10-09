# create-aalis

Aalis 快速初始化脚手架：交互式选插件，生成独立项目与它的家目录 `home/`。

## 用法

```bash
npm create aalis@latest my-bot                 # 问对话模型（可当场粘贴 key）、接入平台与要不要长期语义记忆
npm create aalis@latest my-bot -- --advanced   # 另问模板档、记忆后端、embedding 与向量库
npm create aalis@latest my-bot -- --yes        # 全取默认，不提问
```

## 提供 / 依赖

生成可运行的独立项目：家目录 `home/`（主配置 `aalis.config.yaml`，当场粘贴的密钥写在这里，启动时移进同目录的 `secrets.yaml`，原处换成引用）与 `startAalis()` 入口，写入 `@aalis/core`、`@aalis/runtime` 及所选插件，随后 `npm install`，失败时写明是哪一类原因、怎么修。本机有 Ollama（认 `OLLAMA_HOST`）时对话模型默认用它。本包本身不是插件，无 `provides` / `uses`。

## 文档

详见 [docs/guide/scaffolding.md](../../docs/guide/scaffolding.md)。

## 许可

见仓库根目录 LICENSE。
