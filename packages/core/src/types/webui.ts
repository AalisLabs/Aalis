// ----- WebUI 页面骨架接口 -----
//
// 完整的 WebuiPage（含 content/WebuiComponent 等声明式组件）以及 WebUIService
// 等类型均由 @aalis/plugin-webui-api 提供。
// 此处仅保留最小骨架，供 core/plugin.ts 的 PluginModule 类型引用，
// 避免 core 依赖 webui-api 形成循环。

/** 插件可声明的 WebUI 页面（骨架；webui-api 通过 declaration merging 补全 content 字段） */
export interface WebuiPage {
  /** 页面唯一标识（对应前端路由/标签 key） */
  key: string;
  /** 页面显示名称 */
  label: string;
  /** 图标标识（命名标识或内联 SVG） */
  icon?: string;
  /** 排序权重（越小越靠前，默认 99） */
  order?: number;
  /** 自定义渲染器标识（非声明式 content 场景） */
  renderer?: string;
}
