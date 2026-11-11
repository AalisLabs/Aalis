// ===== OKX API v5 客户端 =====

import { TextError } from '@aalis/schema-i18n';
import { t } from './texts.js';

interface OkxCredentials {
  apiKey: string;
  secretKey: string;
  passphrase: string;
}

interface OkxClientOptions {
  credentials: OkxCredentials;
  baseUrl: string;
  /** 是否模拟盘 */
  demo: boolean;
  timeoutMs: number;
  /** 调用方的中止信号（见 {@link OkxClient.withSignal}） */
  signal?: AbortSignal;
}

interface OkxApiResponse<T = unknown> {
  code: string;
  msg: string;
  data: T;
}

/** 生成 OKX HMAC-SHA256 签名（Web Crypto 实现，跨运行时） */
async function sign(
  timestamp: string,
  method: string,
  requestPath: string,
  body: string,
  secretKey: string,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secretKey), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(prehash(timestamp, method, requestPath, body)));
  return Buffer.from(sig).toString('base64');
}

function prehash(timestamp: string, method: string, requestPath: string, body: string): string {
  return timestamp + method + requestPath + body;
}

/** fetch 的报错写成一句：连接层的原因（ECONNRESET、ENOTFOUND 等）在 cause 的 code 里，message 只是 fetch failed 或 terminated */
function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err.cause as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? `${err.message}: ${code}` : err.message;
}

/** 响应体是 OKX 的回执（带字符串业务码）时交回它，否则（含不是 JSON）为 undefined */
function okxReply<T>(text: string): OkxApiResponse<T> | undefined {
  try {
    const reply = JSON.parse(text) as Partial<OkxApiResponse<T>> | null;
    return typeof reply?.code === 'string' ? (reply as OkxApiResponse<T>) : undefined;
  } catch {
    return undefined;
  }
}

export class OkxClient {
  private opts: OkxClientOptions;

  constructor(opts: OkxClientOptions) {
    this.opts = opts;
  }

  /** 同一个客户端，请求另接 signal（这次工具调用的中止信号），与超时谁先到按谁停 */
  withSignal(signal: AbortSignal | undefined): OkxClient {
    return new OkxClient({ ...this.opts, signal });
  }

  /**
   * 发送已签名的 API 请求。POST 一律是改变状态的请求（下单、撤单、改单、平仓、杠杆、保证金、策略委托、划转）：发出之后被
   * 中止或超时的，OKX 可能已经执行，抛「结果未知」并提示先查询，不报成失败；发出之前已中止的不发，抛中止原因。没拿到确切结果
   * 的（连接出错、读到一半断开、2xx 而响应体不是 OKX 的回执、网关或服务端报 5xx、OKX 的业务码 50004）同样可能已经执行，抛「结果
   * 未知」并带上出错原因；别的照常报失败。不按连接错误的错误码猜请求发没发出：误报结果未知只多一次查询，误报失败可能让模型重下一单
   */
  async request<T = unknown>(
    method: 'GET' | 'POST',
    path: string,
    params?: Record<string, unknown>,
  ): Promise<OkxApiResponse<T>> {
    const { credentials, baseUrl, demo, timeoutMs, signal } = this.opts;
    let requestPath = path;
    let body = '';

    if (method === 'GET' && params) {
      const qs = Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&');
      if (qs) requestPath += `?${qs}`;
    } else if (method === 'POST' && params) {
      body = JSON.stringify(params);
    }

    const timestamp = new Date().toISOString();
    const signature = await sign(timestamp, method, requestPath, body, credentials.secretKey);

    const headers: Record<string, string> = {
      'OK-ACCESS-KEY': credentials.apiKey,
      'OK-ACCESS-SIGN': signature,
      'OK-ACCESS-TIMESTAMP': timestamp,
      'OK-ACCESS-PASSPHRASE': credentials.passphrase,
      'Content-Type': 'application/json',
    };

    if (demo) {
      headers['x-simulated-trading'] = '1';
    }

    const url = `${baseUrl}${requestPath}`;
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: method === 'POST' ? body : undefined,
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
      text = await response.text();
    } catch (err) {
      if (method === 'POST' && (signal?.aborted || timeout.aborted)) {
        throw new TextError(t('abortedAfterSent'), { cause: err });
      }
      if (method === 'POST') {
        throw new TextError(t('outcomeUnknown', { error: describeFetchError(err) }), { cause: err });
      }
      throw err;
    }

    if (method === 'POST' && response.status >= 500) {
      throw new TextError(t('outcomeUnknown', { error: `HTTP ${response.status}` }), { cause: new Error(text) });
    }
    const reply = okxReply<T>(text);
    // OKX 的 50004 是它那边的接口超时，按它的说明不代表成功或失败、要查询结果（不论 HTTP 状态）
    if (method === 'POST' && reply?.code === '50004') {
      throw new TextError(t('outcomeUnknown', { error: 'OKX 50004' }), { cause: new Error(text) });
    }
    // 4xx 照常报失败。2xx 而响应体不是 OKX 的回执：按连接关闭定界的响应读到一半断开时 fetch 不报错，读到的是截断的 JSON；
    // 中转或代理也可能回 200 的网页或别的 JSON
    if (!response.ok || !reply) {
      if (method === 'POST' && response.ok) {
        const error = `HTTP ${response.status}, not an OKX reply`;
        throw new TextError(t('outcomeUnknown', { error }), { cause: new Error(text) });
      }
      throw new Error(`OKX HTTP ${response.status}: ${text}`);
    }
    if (reply.code !== '0') {
      throw new Error(`OKX API 错误 [${reply.code}]: ${reply.msg}`);
    }
    return reply;
  }

  // ========== 账户 ==========

  /** 查询账户余额 */
  async getBalance(ccy?: string) {
    return this.request('GET', '/api/v5/account/balance', ccy ? { ccy } : undefined);
  }

  /** 查询持仓 */
  async getPositions(instType?: string, instId?: string) {
    return this.request('GET', '/api/v5/account/positions', { instType, instId });
  }

  /** 查询账户配置 */
  async getAccountConfig() {
    return this.request('GET', '/api/v5/account/config');
  }

  /** 设置杠杆倍数 */
  async setLeverage(instId: string, lever: string, mgnMode: 'cross' | 'isolated', posSide?: string) {
    return this.request('POST', '/api/v5/account/set-leverage', { instId, lever, mgnMode, posSide });
  }

  /** 设置持仓模式 */
  async setPositionMode(posMode: 'long_short_mode' | 'net_mode') {
    return this.request('POST', '/api/v5/account/set-position-mode', { posMode });
  }

  /** 查询杠杆倍数 */
  async getLeverageInfo(instId: string, mgnMode: 'cross' | 'isolated') {
    return this.request('GET', '/api/v5/account/leverage-info', { instId, mgnMode });
  }

  /** 查询最大可交易数量 */
  async getMaxSize(instId: string, tdMode: string, px?: string) {
    return this.request('GET', '/api/v5/account/max-size', { instId, tdMode, px });
  }

  /** 查询最大可用余额 */
  async getMaxAvailSize(instId: string, tdMode: string) {
    return this.request('GET', '/api/v5/account/max-avail-size', { instId, tdMode });
  }

  /** 调整保证金 */
  async adjustMarginBalance(instId: string, posSide: string, type: 'add' | 'reduce', amt: string) {
    return this.request('POST', '/api/v5/account/position/margin-balance', { instId, posSide, type, amt });
  }

  /** 查询账户风险状态 */
  async getRiskState() {
    return this.request('GET', '/api/v5/account/risk-state');
  }

  /** 查询账户账单流水（近 7 天） */
  async getBills(instType?: string, ccy?: string, type?: string, limit?: number) {
    return this.request('GET', '/api/v5/account/bills', {
      instType,
      ccy,
      type,
      limit: limit ? String(limit) : undefined,
    });
  }

  /** 查询账户账单流水（近 3 月） */
  async getBillsArchive(instType?: string, ccy?: string, type?: string, limit?: number) {
    return this.request('GET', '/api/v5/account/bills-archive', {
      instType,
      ccy,
      type,
      limit: limit ? String(limit) : undefined,
    });
  }

  /** 查询利息累计数据 */
  async getInterestAccrued(instId?: string, ccy?: string, limit?: number) {
    return this.request('GET', '/api/v5/account/interest-accrued', {
      instId,
      ccy,
      limit: limit ? String(limit) : undefined,
    });
  }

  /** 查询手续费费率 */
  async getTradeFee(instType: string, instId?: string) {
    return this.request('GET', '/api/v5/account/trade-fee', { instType, instId });
  }

  /** 查询持仓历史 */
  async getPositionsHistory(instType?: string, instId?: string, limit?: number) {
    return this.request('GET', '/api/v5/account/positions-history', {
      instType,
      instId,
      limit: limit ? String(limit) : undefined,
    });
  }

  // ========== 交易 ==========

  /** 下单 */
  async placeOrder(params: {
    instId: string;
    tdMode: 'cash' | 'cross' | 'isolated';
    side: 'buy' | 'sell';
    ordType: 'market' | 'limit' | 'post_only' | 'fok' | 'ioc';
    sz: string;
    px?: string;
    posSide?: 'long' | 'short' | 'net';
    tgtCcy?: 'base_ccy' | 'quote_ccy';
    clOrdId?: string;
  }) {
    return this.request('POST', '/api/v5/trade/order', params);
  }

  /** 批量下单（最多 20 笔） */
  async batchPlaceOrders(
    orders: Array<{
      instId: string;
      tdMode: string;
      side: string;
      ordType: string;
      sz: string;
      px?: string;
      posSide?: string;
      tgtCcy?: string;
      clOrdId?: string;
    }>,
  ) {
    return this.request('POST', '/api/v5/trade/batch-orders', orders as unknown as Record<string, unknown>);
  }

  /** 撤单 */
  async cancelOrder(instId: string, ordId?: string, clOrdId?: string) {
    return this.request('POST', '/api/v5/trade/cancel-order', { instId, ordId, clOrdId });
  }

  /** 批量撤单 */
  async batchCancelOrders(orders: Array<{ instId: string; ordId?: string; clOrdId?: string }>) {
    return this.request('POST', '/api/v5/trade/cancel-batch-orders', orders as unknown as Record<string, unknown>);
  }

  /** 修改订单 */
  async amendOrder(params: { instId: string; ordId?: string; clOrdId?: string; newSz?: string; newPx?: string }) {
    return this.request('POST', '/api/v5/trade/amend-order', params);
  }

  /** 市价全平 */
  async closePosition(instId: string, mgnMode: 'cross' | 'isolated', posSide?: string) {
    return this.request('POST', '/api/v5/trade/close-position', { instId, mgnMode, posSide });
  }

  /** 查询订单详情 */
  async getOrderDetail(instId: string, ordId?: string, clOrdId?: string) {
    return this.request('GET', '/api/v5/trade/order', { instId, ordId, clOrdId });
  }

  /** 查询未成交订单 */
  async getPendingOrders(instType?: string, instId?: string) {
    return this.request('GET', '/api/v5/trade/orders-pending', { instType, instId });
  }

  /** 查询历史订单（近 7 天） */
  async getOrderHistory(instType: string, instId?: string, limit?: number) {
    return this.request('GET', '/api/v5/trade/orders-history', {
      instType,
      instId,
      limit: limit ? String(limit) : undefined,
    });
  }

  /** 查询成交明细（近 3 天） */
  async getFills(instType?: string, instId?: string, limit?: number) {
    return this.request('GET', '/api/v5/trade/fills', { instType, instId, limit: limit ? String(limit) : undefined });
  }

  /** 查询成交明细（近 3 月） */
  async getFillsArchive(instType: string, instId?: string, limit?: number) {
    return this.request('GET', '/api/v5/trade/fills-archive', {
      instType,
      instId,
      limit: limit ? String(limit) : undefined,
    });
  }

  // ========== 策略委托 ==========

  /** 策略下单（止盈止损 / 计划委托） */
  async placeAlgoOrder(params: {
    instId: string;
    tdMode: 'cash' | 'cross' | 'isolated';
    side: 'buy' | 'sell';
    ordType: 'conditional' | 'oco' | 'trigger';
    sz: string;
    posSide?: 'long' | 'short' | 'net';
    tpTriggerPx?: string;
    tpOrdPx?: string;
    slTriggerPx?: string;
    slOrdPx?: string;
    triggerPx?: string;
    orderPx?: string;
  }) {
    return this.request('POST', '/api/v5/trade/order-algo', params);
  }

  /** 撤销策略委托 */
  async cancelAlgoOrder(params: Array<{ algoId: string; instId: string }>) {
    return this.request('POST', '/api/v5/trade/cancel-algos', params as unknown as Record<string, unknown>);
  }

  /** 查询未完成策略委托 */
  async getPendingAlgoOrders(ordType: string, instType?: string, instId?: string) {
    return this.request('GET', '/api/v5/trade/orders-algo-pending', { ordType, instType, instId });
  }

  /** 查询历史策略委托 */
  async getAlgoOrderHistory(ordType: string, instType?: string, instId?: string, limit?: number) {
    return this.request('GET', '/api/v5/trade/orders-algo-history', {
      ordType,
      instType,
      instId,
      limit: limit ? String(limit) : undefined,
    });
  }

  // ========== 行情 ==========

  /** 获取单个产品行情 */
  async getTicker(instId: string) {
    return this.request('GET', '/api/v5/market/ticker', { instId });
  }

  /** 获取所有产品行情 */
  async getTickers(instType: string) {
    return this.request('GET', '/api/v5/market/tickers', { instType });
  }

  /** 获取 K 线数据 */
  async getCandles(instId: string, bar?: string, limit?: number) {
    return this.request('GET', '/api/v5/market/candles', { instId, bar, limit: limit ? String(limit) : undefined });
  }

  /** 获取历史 K 线数据（更久远） */
  async getHistoryCandles(instId: string, bar?: string, limit?: number, after?: string) {
    return this.request('GET', '/api/v5/market/history-candles', {
      instId,
      bar,
      limit: limit ? String(limit) : undefined,
      after,
    });
  }

  /** 获取深度数据 */
  async getOrderBook(instId: string, sz?: number) {
    return this.request('GET', '/api/v5/market/books', { instId, sz: sz ? String(sz) : undefined });
  }

  /** 获取近期成交记录 */
  async getTrades(instId: string, limit?: number) {
    return this.request('GET', '/api/v5/market/trades', { instId, limit: limit ? String(limit) : undefined });
  }

  /** 获取指数行情 */
  async getIndexTickers(instId?: string, quoteCcy?: string) {
    return this.request('GET', '/api/v5/market/index-tickers', { instId, quoteCcy });
  }

  /** 获取指数 K 线 */
  async getIndexCandles(instId: string, bar?: string, limit?: number) {
    return this.request('GET', '/api/v5/market/index-candles', {
      instId,
      bar,
      limit: limit ? String(limit) : undefined,
    });
  }

  /** 获取标记价格 K 线 */
  async getMarkPriceCandles(instId: string, bar?: string, limit?: number) {
    return this.request('GET', '/api/v5/market/mark-price-candles', {
      instId,
      bar,
      limit: limit ? String(limit) : undefined,
    });
  }

  /** 获取 24 小时总成交量 */
  async get24hVolume() {
    return this.request('GET', '/api/v5/market/platform-24-volume');
  }

  // ========== 公共数据 ==========

  /** 获取交易产品列表 */
  async getInstruments(instType: string, instId?: string) {
    return this.request('GET', '/api/v5/public/instruments', { instType, instId });
  }

  /** 获取标记价格 */
  async getMarkPrice(instType: string, instId?: string) {
    return this.request('GET', '/api/v5/public/mark-price', { instType, instId });
  }

  /** 获取资金费率 */
  async getFundingRate(instId: string) {
    return this.request('GET', '/api/v5/public/funding-rate', { instId });
  }

  /** 获取历史资金费率 */
  async getFundingRateHistory(instId: string, limit?: number) {
    return this.request('GET', '/api/v5/public/funding-rate-history', {
      instId,
      limit: limit ? String(limit) : undefined,
    });
  }

  /** 获取限价 */
  async getPriceLimit(instId: string) {
    return this.request('GET', '/api/v5/public/price-limit', { instId });
  }

  /** 获取持仓总量 */
  async getOpenInterest(instType: string, instId?: string) {
    return this.request('GET', '/api/v5/public/open-interest', { instType, instId });
  }

  // ========== 资金 ==========

  /** 查询资金账户余额 */
  async getAssetBalances(ccy?: string) {
    return this.request('GET', '/api/v5/asset/balances', ccy ? { ccy } : undefined);
  }

  /** 资金划转 */
  async transfer(ccy: string, amt: string, from: string, to: string) {
    return this.request('POST', '/api/v5/asset/transfer', { ccy, amt, from, to, type: '0' });
  }

  /** 查询划转状态 */
  async getTransferState(transId: string) {
    return this.request('GET', '/api/v5/asset/transfer-state', { transId });
  }

  /** 查询资金流水 */
  async getAssetBills(ccy?: string, type?: string, limit?: number) {
    return this.request('GET', '/api/v5/asset/bills', { ccy, type, limit: limit ? String(limit) : undefined });
  }

  /** 获取币种列表 */
  async getCurrencies() {
    return this.request('GET', '/api/v5/asset/currencies');
  }

  /** 获取充值地址 */
  async getDepositAddress(ccy: string) {
    return this.request('GET', '/api/v5/asset/deposit-address', { ccy });
  }

  /** 查询充值记录 */
  async getDepositHistory(ccy?: string, limit?: number) {
    return this.request('GET', '/api/v5/asset/deposit-history', { ccy, limit: limit ? String(limit) : undefined });
  }

  /** 查询提币记录 */
  async getWithdrawalHistory(ccy?: string, limit?: number) {
    return this.request('GET', '/api/v5/asset/withdrawal-history', { ccy, limit: limit ? String(limit) : undefined });
  }

  // ========== 大数据 / 交易大数据 ==========

  /** 多空持仓人数比 */
  async getLongShortRatio(ccy: string, period?: string) {
    return this.request('GET', '/api/v5/rubik/stat/contracts/long-short-account-ratio', { ccy, period });
  }

  /** 合约持仓量及交易量 */
  async getContractOpenInterestVolume(ccy: string, period?: string) {
    return this.request('GET', '/api/v5/rubik/stat/contracts/open-interest-volume', { ccy, period });
  }

  /** Taker 主动买卖量 */
  async getTakerVolume(ccy: string, instType: string, period?: string) {
    return this.request('GET', '/api/v5/rubik/stat/taker-volume', { ccy, instType, period });
  }
}
