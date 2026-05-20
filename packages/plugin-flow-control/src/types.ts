// ----- Flow Control 服务接口 -----
//
// 类型契约已抽到独立 -api 包以便下游 adapter / trigger-policy 不再硬
// 依赖本实现包。本文件保留 re-export 用于内部 import 路径不变；新代码
// 请直接从 @aalis/plugin-flow-control-api 导入。
export type { FlowControlService, FlowSessionStateSnapshot } from '@aalis/plugin-flow-control-api';
