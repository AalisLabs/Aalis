# plugin-okx-trading — OKX 交易所接口

**包名**: `@aalis/plugin-okx-trading`  
**源码**: `packages/plugin-okx-trading/src/index.ts`

## 概述

OKX 加密货币交易所 API 集成，支持模拟盘和实盘模式，包含行情查询、账户管理和下单功能。

## 插件声明

```typescript
meta.name = '@aalis/plugin-okx-trading'
meta.inject = {}
```

## 配置

| 字段 | 类型 | 说明 |
|---|---|---|
| `apiKey` | string | OKX API Key |
| `secretKey` | string | OKX Secret Key |
| `passphrase` | string | API 口令 |
| `mode` | select | `demo` (模拟) / `live` (实盘) |

## 注册工具

- **行情**: 查询交易对行情、K线、深度
- **账户**: 查询余额、持仓、账户信息
- **下单**: 现货/合约下单、取消订单、查询订单
- **资金**: 资金划转（可选）
- **策略**: 算法交易策略（可选）
