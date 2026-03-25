import { App } from '@aalis/core';

async function main() {
  const app = new App();

  // 自动扫描 packages/ 并加载所有插件
  await app.autoLoadPlugins();

  // 启动
  await app.start();

  // 优雅退出（防止重复调用）
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
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
