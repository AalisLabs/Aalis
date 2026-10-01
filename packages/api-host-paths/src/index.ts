/**
 * @aalis/api-host-paths — 宿主路径契约
 *
 * 家目录装着一个实例的全部状态：配置、密钥、数据库、日志、人设卡、技能、舞台。安装集是放 package.json 与
 * node_modules 的目录。两者都由宿主在启动时解析一次，之后不变；进程的 cwd 不带任何语义。
 * Node 宿主 @aalis/runtime 把解析结果作为 host-paths 服务独占登记在根上；别的宿主要让插件定位这些目录，
 * 自己提供本描述符。插件要用时在 uses 里声明，不读 `process.cwd()`。
 */

import { defineService } from '@aalis/core';

/** 宿主解析出的路径，全部是绝对路径。 */
export interface HostPaths {
  /** 家目录。Node 宿主给的是真实路径（符号链接已解开），同一个目录不论怎么写都是同一个字符串 */
  readonly home: string;
  /** profile 名：家目录是 `~/.aalis-<profile>` 时才有，不论经 `--profile` 还是 `--home` 选中 */
  readonly profile?: string;
  /** 安装集：package.json、node_modules 所在目录（源码形态另有 packages/） */
  readonly app: string;
  /** 主配置文件 `aalis.config.yaml` */
  readonly config: string;
  /** 密钥文件 `secrets.yaml` */
  readonly secrets: string;
  /** 插件状态：数据库、向量库、checkpoint、各插件的数据目录 */
  readonly state: string;
  readonly logs: string;
  readonly cache: string;
  /** 运行期文件：runtime 的实例锁，以后还放 socket */
  readonly run: string;
  /** 临时区，按会话分子目录 */
  readonly tmp: string;
  readonly self: {
    /** 人设卡 */
    readonly personas: string;
    /** 技能 */
    readonly skills: string;
    /** 存下来的编排定义 */
    readonly workflows: string;
  };
  readonly stage: {
    /** 草稿，不对外 */
    readonly drafts: string;
    /** 发布后对外的作品 */
    readonly public: string;
    /** 各房间的白纸 */
    readonly paper: string;
  };
}

export const hostPaths = defineService<HostPaths>('host-paths');
