# plugin-okx-trading — OKX 交易所接口

**包名**: `@aalis/plugin-okx-trading`  
**源码**: `packages/plugin-okx-trading/src/index.ts`

## 概述

OKX 加密货币交易所 API 集成，支持模拟盘和实盘，包含行情查询、账户管理、下单交易和策略委托功能。默认模拟盘；实盘动用真实资金需显式确认风险（详见下文实盘安全闸）。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-okx-trading',
  subsystem: 'external',
  uses: {
    tools: optional(tools),
    logger,
    config,
  },
  apply(caps) { /* 见源码 */ },
});
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `apiKey` | string | 必填 | API Key：在 OKX 设置中创建的 API Key（secret） |
| `secretKey` | string | 必填 | Secret Key（secret） |
| `passphrase` | string | 必填 | Passphrase：创建 API 时设定的口令（secret） |
| `baseUrl` | string | `'https://www.okx.com'` | API 地址：默认实盘地址，可改为自定义域名。带查询串或片段（`?` 或 `#` 之后的部分：插件在它后面拼路径）时激活报配置错误 |
| `demo` | boolean | `true` | 模拟盘：启用后将使用模拟交易环境，强烈建议先在模拟盘测试 |
| `confirmRealMoney` | boolean | `false` | 确认实盘风险：关闭模拟盘、用真实资金交易时须打开以确认风险；不打开时只保留查询，不提供下单、策略与划转等交易工具。 |
| `timeoutMs` | number | `15000` | 请求超时 (ms) |
| `enableTrading` | boolean | `true` | 启用交易工具：关闭后仅保留查询类工具，不暴露下单/撤单操作 |
| `enableAlgo` | boolean | `false` | 启用策略委托：启用止盈止损 / 计划委托工具 |
| `enableTransfer` | boolean | `false` | 启用资金划转：启用资金账户划转工具 |
| `defaultPageLimit` | number | `20` | 分页查询默认条数：查询订单/账单/成交明细等接口，模型未传 limit 时使用。 |
| `maxPageLimit` | number | `100` | 分页查询最大条数：分页查询一次最多返回的条数，模型要的更多时按这个值算。调大会让单次工具结果变大。 |

分页查询查到的条目整份交给模型；OKX API 本身单页一般最多 100 条（个别接口 300）。

`apiKey`、`secretKey`、`passphrase` 缺一个插件就激活失败，报缺的那一项，WebUI 把它标成待配置。

## 实盘安全闸

本插件刻意保留实时 / 算法交易能力，因此**不做逐单人工确认**，改用「等级门禁 + 一次性显式确认 + 启动告警」三道闸。前提是 `demo` 默认 `true`：交易工具默认可用，但走的是模拟环境。

1. **等级门禁（restricted）**：涉及资金或仓位变更的工具被标记 `visibility: 'restricted'`（最低等级 2），防止任意访客经 LLM 以 owner 的资金下单或划转。其余查询类工具分两档：读取账户、订单、资金流水、充值地址等私有数据的查询工具（源码 `ACCOUNT_READ_OKX_TOOLS`）标记 `risk: 'sensitive'`（最低等级 1），挡住等级 0 用户经 LLM 读取 owner 的账户数据；行情与 Rubik 指标等公开数据工具维持默认 public。
2. **实盘显式确认**：当 `demo:false`（真实资金）时，必须同时设 `confirmRealMoney:true`，否则插件不注册下单、策略委托、资金划转三组工具（含这三组里的查询工具），只保留行情、指标、账户、订单查询四组。即这三组工具是否注册取决于 `demo || confirmRealMoney`。
3. **启动告警**：实盘启动时打告警日志：开启 `confirmRealMoney` 提示「模型可用真实资金下单……无逐单人工确认」；未开启则提示已禁用交易工具仅保留查询。

被标 `restricted` 的变更类工具：

```
okx_place_order        okx_cancel_order        okx_amend_order
okx_set_leverage       okx_set_position_mode   okx_adjust_margin
okx_batch_place_orders okx_batch_cancel_orders okx_close_position
okx_place_algo_order   okx_cancel_algo_order   okx_transfer
```

## 注册工具

工具通过 `tools` 服务注册到 `okx` 分组（label「OKX 交易」），变更类工具自动标 `restricted`：

- **行情** (`registerMarketTools`): 查询交易对行情、K线、深度
- **指标** (`registerRubikTools`): Rubik 大数据指标
- **账户** (`registerAccountTools`): 查询余额、持仓、账户信息、账单（带分页）
- **订单查询** (`registerOrderQueryTools`): 历史 / 当前订单、成交明细（带分页）
- **下单** (`registerTradeTools`): 现货/合约下单、撤单、改单、批量、平仓、杠杆/仓位/保证金设置，以及订单详情、近 3 个月成交明细查询 —— 需 `enableTrading` 且实盘安全闸放行
- **策略** (`registerAlgoTools`): 止盈止损（含 oco）/ 计划委托的下单、撤单与查询 —— 需 `enableAlgo` 且实盘安全闸放行
- **资金** (`registerTransferTools`): 资金账户划转，以及划转状态、资金账单、充值地址、充提记录查询 —— 需 `enableTransfer` 且实盘安全闸放行

各组内的查询工具随所在组一起受开关和实盘安全闸控制。

## 请求的超时与中止

每个请求带 `timeoutMs` 超时，另接执行器给这次工具调用的中止信号（回合中止时停下），谁先到按谁停。查询类请求中止或超时了就是没查到，回中止原因或超时。改变状态的请求（POST：下单、撤单、改单、平仓、杠杆与仓位模式、保证金、策略委托、划转）发出之后被中止或超时的，OKX 可能已经执行，回「请求已发出后中止，OKX 是否已执行未知：先查询订单、持仓或资金状态，确认之后再决定是否重试」，不报成失败；发出之前已中止的不发请求，回中止原因。改变状态的请求没拿到确切结果的（连接出错、读到一半断开、2xx 而响应体不是 OKX 的回执（截断的 JSON、中转或代理回的网页等）、网关或服务端报 5xx、OKX 的业务码 50004 即它那边的接口超时）同样可能已经执行，回「请求没拿到 OKX 的确切结果（出错原因），是否已执行未知」并提示先查询，连接出错时出错原因带上连接层的错误码（如 `fetch failed: ECONNRESET`）；别的照常报失败。不按连接错误的错误码猜请求发没发出：误报结果未知只多一次查询，误报失败可能让模型重下一单。

## 逐项的结果

下单、撤单、改单的回执逐项带结果（`sCode` 为 0 即这一项成功，否则 `sMsg` 是原因）。批量操作部分成功（OKX 的业务码 2）时照常交回逐项的结果，不报整体失败，否则模型照着整批重下，已经下成的那几单又下一遍。别的业务码报失败时把各项的结果带进报错（单笔下单失败回 1，原因只在逐项结果里）。

## 配置校验

凭证没填全时激活失败（见上）。凭证、地址、模拟盘与实盘确认开关、交易功能开关的显式无效值会报配置错误；地址格式在工具注册前校验。分页上限仍夹在 1–1000，默认条数取整、至少 1 且不超过上限。
