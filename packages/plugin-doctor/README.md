# @aalis/plugin-doctor

自检诊断：体检配置/服务/依赖并给出修复建议

## 安装

```bash
pnpm add @aalis/plugin-doctor
```

## 提供 / 依赖

`definePlugin` 默认导出：

- provides：`doctor`
- uses：`provide`、`logger`、`events`；可选 `plugins`、`commands`、`webui`（`webui-server`）

## 文档

详见 [docs/services/doctor.md](../../docs/services/doctor.md)。

## 许可

见仓库根目录 LICENSE。
