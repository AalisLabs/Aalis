// ----- 网络搜索服务接口 -----
//
// 由 plugin-websearch-serper 等插件实现。Agent 或其他插件可通过
// `ctx.getService<WebSearchService>('web-search')` 获得该服务来执行搜索，
// 而无需关心具体后端（Serper / DuckDuckGo / Bing 等）。
//
// 多个搜索后端可同时注册，框架按 priority 选择默认实现；
// 若需指定特定后端（如只使用带新闻能力的后端），可通过 capability 过滤：
//   `ctx.getService<WebSearchService>('web-search', ['news'])`

/** 单条搜索结果 */
export interface WebSearchResult {
  /** 条目标题 */
  title: string;
  /** 条目 URL */
  url: string;
  /** 摘要/片段（可能为空） */
  snippet?: string;
  /** 来源站点（可选，如 "wikipedia.org"） */
  source?: string;
  /** 发布或更新日期（可选，ISO 字符串） */
  publishedAt?: string;
}

/** 搜索请求参数 */
export interface WebSearchRequest {
  /** 搜索关键词 */
  query: string;
  /** 期望返回的结果数（后端决定最大值） */
  numResults?: number;
  /** 语言偏好（如 'zh' / 'en'），后端可忽略 */
  language?: string;
  /** 搜索类型筛选（后端按 capability 声明的支持范围处理） */
  kind?: 'web' | 'news' | 'images';
}

/** 搜索响应 */
export interface WebSearchResponse {
  /** 搜索关键词（回显） */
  query: string;
  /** 结果列表 */
  results: WebSearchResult[];
  /** 后端给出的摘要/答案框（如 Serper 的 answerBox） */
  answer?: string;
  /** 相关问题（若后端支持） */
  relatedQuestions?: string[];
  /** 后端元信息（如耗时、总条数等） */
  raw?: Record<string, unknown>;
}

/**
 * 网络搜索服务
 *
 * 实现者需至少提供 `search()`。`describeProvider()` 用于日志/WebUI 展示。
 */
export interface WebSearchService {
  /** 执行一次搜索 */
  search(request: WebSearchRequest): Promise<WebSearchResponse>;
  /** 后端标识（供日志/排错用），如 'serper' */
  readonly providerName: string;
}
