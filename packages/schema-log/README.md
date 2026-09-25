# @aalis/schema-log

日志记录与日志行格式的共享契约，以 peer 依赖引用 `@aalis/core` 的日志记录类型（仅类型导入），不执行 I/O。

- `LogEntry`、`LogLevel`：Core 日志通道、宿主与前端共享的数据类型，从 `@aalis/core` 原样转导出。
- `formatLogLine`、`parseLogLine`：宿主写入、CLI 和 WebUI 读取日志文件时共用的编解码函数。

日志通道 `LogHub` 与 `Logger` 接口仍由 `@aalis/core` 提供；文件写入、终端显示、历史分页由各消费者负责。

新写入使用带版本的 JSON 行，每条以 LF 结束：

```text
@aalis/log:1 {"seq":42,"timestamp":"2026-09-21T10:20:30.000+08:00","level":"info","scope":"worker","message":"hello"}
```

`formatLogLine` 只写入五个契约字段。字符串中的反斜杠、真实换行、CRLF、控制字符、分隔符和尾部空白可无损恢复；Unicode 行分隔符也会转义，确保一条记录只占一条物理行。时间戳保留原字符串，不重新解释或规范化。

`parseLogLine` 可接收带或不带行尾的记录，要求 `seq` 是有限数字，`level` 是 `debug`、`info`、`warn` 或 `error`，其余三个字段是字符串。缺少版本前缀的行（包括旧的 `seq|timestamp|level|scope|message` 行）、未知版本、损坏 JSON、缺失或非法字段返回 `null`；额外字段不进入返回对象。
