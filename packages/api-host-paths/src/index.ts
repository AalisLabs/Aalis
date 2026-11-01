/**
 * @aalis/api-host-paths — 宿主路径契约
 *
 * 家目录装着一个实例的全部状态：配置、密钥、数据库、日志、人设卡、技能、默认工作区。安装集是放 package.json 与
 * node_modules 的目录，也就是部署目录：没有另行指定时，家目录就在它下面（{@link HOME_DIR}）。两者都由宿主在启动时
 * 解析一次，之后不变；进程的 cwd 不带任何语义。
 * Node 宿主 @aalis/runtime 把解析结果作为 host-paths 服务独占登记在根上；别的宿主要让插件定位这些目录，
 * 自己提供本描述符。插件要用时在 uses 里声明，不读 `process.cwd()`。
 */

import { defineService } from '@aalis/core';

/**
 * 部署目录下缺省的家目录名：没有 profile 时是 `data`，profile p 是 `data-<p>`。宿主按它解析家目录，触及按它认出
 * 同一部署下的其他实例
 */
export const HOME_DIR = 'data';

/** 宿主解析出的路径，全部是绝对路径。 */
export interface HostPaths {
  /** 家目录。Node 宿主给的是真实路径（符号链接已解开），同一个目录不论怎么写都是同一个字符串 */
  readonly home: string;
  /** profile 名：经 `--profile` 或 `AALIS_PROFILE` 选中家目录时才有（家目录是部署目录下的 `data-<profile>`） */
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
  /** 存下来就会自己生效、owner 与她都会读改的内容（人设、技能等），各插件在里面按目录名分开（api-storage 的 content） */
  readonly self: string;
  /** 默认工作区：owner 本机默认工作区的真实文件夹，`<家目录>/workspace` */
  readonly workspace: string;
}

export const hostPaths = defineService<HostPaths>('host-paths');
