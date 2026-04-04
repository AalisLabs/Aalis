#![allow(non_upper_case_globals)]

//! macOS Accessibility (AX) API 原生绑定
//!
//! 通过 napi-rs 暴露给 Node.js，提供完整的 UI 元素树读取和操作能力。

mod accessibility;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};

#[cfg(target_os = "macos")]
use accessibility::*;

// ──────────── 数据结构 ────────────

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AXElementInfo {
  /// 元素路径，如 "AXWindow[0]/AXGroup[1]/AXButton[0]"
  pub path: String,
  /// AX 角色 (AXButton, AXTextField, AXStaticText, etc.)
  pub role: String,
  /// 角色描述
  pub role_description: Option<String>,
  /// 元素标题/标签
  pub title: Option<String>,
  /// 元素值（文本框内容等）
  pub value: Option<String>,
  /// 元素描述
  pub description: Option<String>,
  /// 是否可交互
  pub enabled: Option<bool>,
  /// 是否拥有焦点
  pub focused: Option<bool>,
  /// 屏幕坐标位置
  pub x: Option<f64>,
  /// 屏幕坐标位置
  pub y: Option<f64>,
  /// 元素宽度
  pub width: Option<f64>,
  /// 元素高度
  pub height: Option<f64>,
  /// 支持的操作列表
  pub actions: Vec<String>,
  /// 子元素数量
  pub children_count: i32,
  /// 子元素（递归）
  pub children: Vec<AXElementInfo>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AXProcessInfo {
  pub pid: i32,
  pub name: String,
  pub bundle_id: Option<String>,
}

// ──────────── 权限检测 ────────────

/// 检查当前进程是否拥有 macOS 辅助功能权限
#[napi]
pub fn check_accessibility_permission() -> bool {
  #[cfg(target_os = "macos")]
  {
    ax_check_permission(false)
  }
  #[cfg(not(target_os = "macos"))]
  {
    true
  }
}

/// 检查并弹出权限请求对话框（如果未授权）
#[napi]
pub fn request_accessibility_permission() -> bool {
  #[cfg(target_os = "macos")]
  {
    ax_check_permission(true)
  }
  #[cfg(not(target_os = "macos"))]
  {
    true
  }
}

// ──────────── UI 树读取 ────────────

/// 获取指定应用（按 PID）的 UI 元素树
///
/// - `pid`: 目标进程 PID
/// - `max_depth`: 最大递归深度（建议 3-5，太深会很慢）
/// - `include_invisible`: 是否包含不可见元素
#[napi]
pub fn get_ui_tree(pid: i32, max_depth: i32, include_invisible: Option<bool>) -> Result<Vec<AXElementInfo>> {
  #[cfg(target_os = "macos")]
  {
    ax_get_ui_tree(pid, max_depth, include_invisible.unwrap_or(false))
      .map_err(|e| Error::from_reason(e))
  }
  #[cfg(not(target_os = "macos"))]
  {
    Err(Error::from_reason("UI tree is only available on macOS"))
  }
}

/// 查找匹配条件的 UI 元素
///
/// - `pid`: 目标进程 PID
/// - `role`: 按角色过滤（如 "AXButton", "AXTextField"）
/// - `title`: 按标题模糊匹配
/// - `max_depth`: 搜索深度
#[napi]
pub fn find_elements(
  pid: i32,
  role: Option<String>,
  title: Option<String>,
  max_depth: Option<i32>,
) -> Result<Vec<AXElementInfo>> {
  #[cfg(target_os = "macos")]
  {
    ax_find_elements(pid, role, title, max_depth.unwrap_or(10))
      .map_err(|e| Error::from_reason(e))
  }
  #[cfg(not(target_os = "macos"))]
  {
    Err(Error::from_reason("find_elements is only available on macOS"))
  }
}

// ──────────── 元素操作 ────────────

/// 对指定路径的 UI 元素执行操作
///
/// - `pid`: 目标进程 PID
/// - `element_path`: 元素路径，如 "AXWindow[0]/AXGroup[1]/AXButton[0]"
/// - `action`: 操作名，如 "AXPress", "AXRaise", "AXConfirm", "AXCancel"
#[napi]
pub fn perform_action(pid: i32, element_path: String, action: String) -> Result<bool> {
  #[cfg(target_os = "macos")]
  {
    ax_perform_action(pid, &element_path, &action)
      .map_err(|e| Error::from_reason(e))
  }
  #[cfg(not(target_os = "macos"))]
  {
    Err(Error::from_reason("perform_action is only available on macOS"))
  }
}

/// 设置指定路径 UI 元素的值
///
/// - `pid`: 目标进程 PID
/// - `element_path`: 元素路径
/// - `value`: 要设置的新值（字符串）
#[napi]
pub fn set_element_value(pid: i32, element_path: String, value: String) -> Result<bool> {
  #[cfg(target_os = "macos")]
  {
    ax_set_value(pid, &element_path, &value)
      .map_err(|e| Error::from_reason(e))
  }
  #[cfg(not(target_os = "macos"))]
  {
    Err(Error::from_reason("set_element_value is only available on macOS"))
  }
}

/// 获取屏幕上指定坐标处的 UI 元素信息
///
/// - `pid`: 目标进程 PID（0 = 系统级）
/// - `x`: 屏幕 X 坐标
/// - `y`: 屏幕 Y 坐标
#[napi]
pub fn get_element_at_position(pid: i32, x: f64, y: f64) -> Result<Option<AXElementInfo>> {
  #[cfg(target_os = "macos")]
  {
    ax_element_at_position(pid, x, y)
      .map_err(|e| Error::from_reason(e))
  }
  #[cfg(not(target_os = "macos"))]
  {
    Err(Error::from_reason("get_element_at_position is only available on macOS"))
  }
}

// ──────────── 进程列表 ────────────

/// 获取当前运行的、拥有 UI 的应用列表
#[napi]
pub fn list_ui_processes() -> Result<Vec<AXProcessInfo>> {
  #[cfg(target_os = "macos")]
  {
    ax_list_processes()
      .map_err(|e| Error::from_reason(e))
  }
  #[cfg(not(target_os = "macos"))]
  {
    Err(Error::from_reason("list_ui_processes is only available on macOS"))
  }
}
