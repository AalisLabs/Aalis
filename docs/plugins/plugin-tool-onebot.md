# plugin-tool-onebot — OneBot 群管工具

**包名**: `@aalis/plugin-tool-onebot`  
**源码**: `packages/plugin-tool-onebot/src/index.ts`

## 概述

OneBot 协议特定的群管理工具集，AI 可在群聊中执行禁言、踢人、查询成员等操作。

## 插件声明

```typescript
meta.name = '@aalis/plugin-tool-onebot'
meta.inject = { required: ['platform'] }
```

## 注册工具

| 工具 | 说明 | 安全等级 |
|---|---|---|
| `group_mute` | 禁言群成员 | dangerous |
| `group_kick` | 踢出群成员 | dangerous |
| `group_nickname` | 设置群成员昵称 | normal |
| `group_members` | 查询群成员列表 | normal |
| `group_poke` | 戳一戳成员 | normal |
