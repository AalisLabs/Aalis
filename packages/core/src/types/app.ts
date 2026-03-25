// ----- App 服务接口 -----

/**
 * App 生命周期接口
 *
 * 插件通过 `ctx.getService<AppService>('app')` 获取，
 * 用于触发应用级操作（停止、重启、保存配置等），
 * 无需直接导入 App 类。
 */
export interface AppService {
  /** 停止应用 */
  stop(): Promise<void>;
  /** 重启应用（延迟 spawn 新进程后退出当前进程） */
  restart(): void;
  /** 保存配置到磁盘 */
  saveConfig(): void;
}
