# plugin-okx-trading — OKX 交易所接口

**包名**: `@aalis/plugin-okx-trading`  
**源码**: `packages/plugin-okx-trading/src/index.ts`

## 概述

OKX 加密货币交易所 API 集成，支持模拟盘和实盘，包含行情查询、账户管理、下单交易和策略委托功能。默认模拟盘；实盘动用真实资金需显式确认风险（详见下文实盘安全闸）。

## 插件声明

```typescript
meta.name = '@aalis/plugin-okx-trading'
meta.subsystem = 'external'
meta.inject = { optional: ['tools'] }
```

## 配置

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `apiKey` | string (secret) | — | OKX API Key（必填） |
| `secretKey` | string (secret) | — | OKX Secret Key（必填） |
| `passphrase` | string (secret) | — | 创建 API 时设定的口令（必填） |
| `baseUrl` | string | `https://www.okx.com` | API 地址，默认实盘地址，可改为自定义域名 |
| `demo` | boolean | `true` | 启用模拟交易环境；强烈建议先在模拟盘测试 |
| `confirmRealMoney` | boolean | `false` | 仅当关闭模拟盘(`demo:false`)、用真实资金时须显式设为 `true` 确认风险，否则不暴露交易类工具 |
| `timeoutMs` | number | `15000` | 请求超时 (ms) |
| `enableTrading` | boolean | `true` | 关闭后仅保留查询类工具，不暴露下单/撤单操作 |
| `enableAlgo` | boolean | `false` | 启用止盈止损 / 计划委托工具 |
| `enableTransfer` | boolean | `false` | 启用资金账户划转工具 |
| `defaultPageLimit` | number | `20` | 分页查询默认条数（LLM 未传 limit 时使用） |
| `maxPageLimit` | number | `100` | 分页查询最大条数，LLM 传入的 limit 会被 cap 到该值 |

未配置 `apiKey` / `secretKey` / `passphrase` 时插件跳过初始化（仅打 warn）。

## 实盘安全闸

OKX 刻意保留实时 / 算法交易能力，因此**不做逐单人工确认**，改用「等级门禁 + 一次性显式确认 + 启动告警」三道闸：

1. **模拟盘默认开启**：`demo` 默认 `true`，交易工具默认可用但走的是模拟环境。
2. **实盘双重确认**：当 `demo:false`（真实资金）时，必须同时设 `confirmRealMoney:true`，否则插件禁用下单 / 撤单 / 策略 / 划转 / 提币等交易工具，仅保留查询。即下单类工具是否注册取决于 `demo || confirmRealMoney`。
3. **等级门禁（restricted）**：所有动真金白银 / 改仓位的工具被标记 `visibility: 'restricted'`（最低等级 2），堵住「任意 visitor 驱动 LLM 用 owner 真钱下单/划转」。其余查询类工具沿用默认可见性。

被标 `restricted` 的变更类工具：

```
okx_place_order        okx_cancel_order        okx_amend_order
okx_set_leverage       okx_set_position_mode   okx_adjust_margin
okx_batch_place_orders okx_batch_cancel_orders okx_close_position
okx_place_algo_order   okx_cancel_algo_order   okx_transfer
```

实盘启动时还会打告警日志：开启 `confirmRealMoney` 提示「LLM 可用真实资金下单……无逐单人工确认」；未开启则提示已禁用交易工具仅保留查询。

## 注册工具

工具通过 `tools` 服务注册到 `okx` 分组（label「OKX 交易」），变更类工具自动标 `restricted`：

- **行情** (`registerMarketTools`): 查询交易对行情、K线、深度
- **指标** (`registerRubikTools`): Rubik 大数据指标
- **账户** (`registerAccountTools`): 查询余额、持仓、账户信息、账单（带分页）
- **订单查询** (`registerOrderQueryTools`): 历史 / 当前订单、成交明细（带分页）
- **下单** (`registerTradeTools`): 现货/合约下单、撤单、改单、批量、平仓、杠杆/仓位/保证金设置 —— 需 `enableTrading` 且实盘安全闸放行
- **策略** (`registerAlgoTools`): 止盈止损 / 计划委托 —— 需 `enableAlgo` 且实盘安全闸放行
- **资金** (`registerTransferTools`): 资金账户划转 —— 需 `enableTransfer` 且实盘安全闸放行
