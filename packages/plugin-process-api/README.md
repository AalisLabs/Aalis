# @aalis/plugin-process-api

子进程接口插件：把 `child_process` / `os.tmpdir` 集中到一个服务接口，业务插件通过 `ProcessService` 调用本地命令、创建临时目录。默认本地实现见 `@aalis/plugin-process-local`。
