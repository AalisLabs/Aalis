// 本包自己的原文表，没有依赖：texts.ts 用它登记字典，resolve.ts 用它取罗列的分隔符（从 texts.ts 取会成
// define → resolve → texts → define 的环）
export const SOURCE = { lines: '{items, lines}', clauses: '{head}；{tail}', listSeparator: '、' } as const;
