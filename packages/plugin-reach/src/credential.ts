// ============================================================
// 触及凭据：按一次工具调用签发，带品牌符号，冻结
//
// 签发时的触及定下命令在哪执行、场所的主目录与白纸、子进程环境；判定、存储兜底与沙箱策略每次按当时的触及。
// ============================================================

import {
  judgeReach,
  REACH_CREDENTIAL,
  type Reach,
  type ReachAskReason,
  type ReachCredential,
  type ReachDecision,
  type ReachRequest,
  sandboxPolicyOf,
} from '@aalis/api-reach';
import { sandboxEnv } from './process-env.js';

interface CredentialDeps {
  /** 操作系统用户的家目录：沙箱里 npm 的用户配置从这里的 .npmrc 去掉凭据行 */
  userHome: string;
  /** 在场所的主目录下取的 login shell 环境 */
  loginEnv(home: string): Promise<Record<string, string>>;
}

/** current 每次调用都算出这次调用当时的触及 */
export function issueCredential(current: () => Reach, deps: CredentialDeps): ReachCredential {
  const issued = current();
  const local = issued.exec === 'none' ? undefined : issued;
  const credential: Omit<ReachCredential, typeof REACH_CREDENTIAL> = {
    exec: issued.exec,
    ...(local && { home: local.home, paper: local.paper }),
    async require(request) {
      const decision = judgeReach(current(), request);
      return decision.verdict === 'allow' ? { allowed: true } : { allowed: false, message: explain(decision, request) };
    },
    allows: (effect, realPath) => judgeReach(current(), { effect, path: realPath }).verdict === 'allow',
    sandboxPolicy: () => sandboxPolicyOf(current()),
    async processEnv(mode) {
      if (!local) throw new Error('这次调用没有本地效果，没有子进程环境');
      const env = await deps.loginEnv(local.home);
      return mode === 'host' ? { ...env } : sandboxEnv(env, local.sessionTmp, deps.userHome);
    },
  };
  // 品牌不可枚举：展开或 Object.assign 复制出来、改了方法再转交的对象不带它
  return Object.freeze(Object.defineProperty(credential, REACH_CREDENTIAL, { value: true })) as ReachCredential;
}

/** 回给模型的话：要做什么、为什么不行、能不能申请 */
function explain(decision: Exclude<ReachDecision, { verdict: 'allow' }>, request: ReachRequest): string {
  const subject = subjectOf(request);
  if (decision.verdict === 'ask') return `${subject}：${why(decision.reason)}，要 owner 批准，这里没有可用的审批`;
  switch (decision.rule) {
    case 'no-local-effect':
      return `${subject}：这一轮不只有 owner 的话，没有本地效果`;
    case 'control-plane':
      return `${subject}：在宿主控制面里，任何档位都不能写；不可申请，不要尝试绕过`;
    case 'deny-read':
      return `${subject}：在拒读清单里；不可申请，不要尝试绕过`;
    case 'boundary-policy':
      return `${subject}：${why(decision.reason)}，越界策略是直接拒绝`;
  }
}

function subjectOf(request: ReachRequest): string {
  switch (request.effect) {
    case 'read':
      return `读 ${request.path}`;
    case 'write':
      return 'path' in request ? `写 ${request.path}` : `写编排定义 ${request.workflow}`;
    case 'exec':
      return request.host ? '在沙箱外执行命令' : '执行命令';
    case 'network':
      return { url: '访问模型给的网址', command: '执行要联网的命令', provider: '联网' }[request.via];
  }
}

function why(reason: ReachAskReason): string {
  switch (reason.kind) {
    case 'tier':
      return '修改确认档里每一次写与执行都要问';
    case 'boundary':
      return { 'write-path': '超出了可写范围', 'host-exec': '要在沙箱外执行', network: '只读档里联网要问' }[
        reason.target
      ];
    case 'landing':
      return '这里会被自动执行或用于持久化';
  }
}
