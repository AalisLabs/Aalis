import { App } from '@aalis/core';

// 插件导入
import * as pluginPersona from 'aalis-plugin-persona';
import * as pluginOpenAI from 'aalis-plugin-openai';
import * as pluginMemoryMongoDB from 'aalis-plugin-memory-mongodb';
import * as pluginMemorySQLite from 'aalis-plugin-memory-sqlite';
import * as pluginCLI from 'aalis-plugin-cli';
import * as pluginWebSearch from 'aalis-plugin-websearch';
import * as pluginWebUI from 'aalis-plugin-webui';

async function main() {
  const app = new App();

  // 按从底层到高层的顺序注册插件:
  // 1. 人格 (无依赖)
  // 2. LLM (无依赖)
  // 3. 记忆 (无依赖)
  // 4. 工具 (无依赖，注册 AI 可用工具)
  // 5. 平台 (可选依赖 llm)
  await app.plugin(pluginPersona);
  await app.plugin(pluginOpenAI);
  await app.plugin(pluginMemoryMongoDB);
  await app.plugin(pluginMemorySQLite);
  await app.plugin(pluginWebSearch);
  await app.plugin(pluginCLI);
  await app.plugin(pluginWebUI);

  // 启动
  await app.start();

  // 优雅退出
  const shutdown = async () => {
    await app.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
