// ----- 网络搜索服务接口 -----
//
// 由 plugin-websearch-serper 等插件实现。消费方在 uses 里声明本包导出的 `webSearch`
// 描述符，即可拿到按激活绑定的调用接口，而无需关心具体后端（Serper / DuckDuckGo / Bing 等）。
//
// 多个搜索后端可同时注册：`webSearch.current` 取当前胜者（偏好 > 优先级 > 注册顺序），
// 要在多个后端间挑选（如只用带新闻能力的）就用 `webSearch.all()` 自行筛。

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
  /** 搜索类型筛选，后端可忽略不支持的类型 */
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
 * 实现者需至少提供 `search()`。`providerName` 用于日志/排错。
 */
export interface WebSearchService {
  /** 执行一次搜索 */
  search(request: WebSearchRequest): Promise<WebSearchResponse>;
  /** 后端标识（供日志/排错用），如 'serper' */
  readonly providerName: string;
}
