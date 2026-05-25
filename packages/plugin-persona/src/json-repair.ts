// 此文件已迁移到 @aalis/util-json-repair（供多个 plugin 共享）。
// 保留 re-export 以兼容已有相对 import，新代码请直接 import @aalis/util-json-repair。

export type { RepairResult } from '@aalis/util-json-repair';
export { extractJsonCandidate, parseLLMJsonObject, tryParseJsonObject } from '@aalis/util-json-repair';
