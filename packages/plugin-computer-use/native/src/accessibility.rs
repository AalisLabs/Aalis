//! macOS Accessibility API 封装
//!
//! 通过 ApplicationServices 框架的 AXUIElement API 实现
//! UI 元素树遍历、查找和操作。

#![cfg(target_os = "macos")]
#![allow(non_snake_case)]

use crate::{AXElementInfo, AXProcessInfo};
use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use std::ffi::c_void;
use std::ptr;

// ──────────── FFI 声明 ────────────

// AXUIElement 类型是 opaque pointer
type AXUIElementRef = *const c_void;
type AXError = i32;

const kAXErrorSuccess: AXError = 0;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;

    fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;

    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: *const c_void, // CFStringRef
        value: *mut *const c_void,
    ) -> AXError;

    fn AXUIElementCopyAttributeNames(
        element: AXUIElementRef,
        names: *mut *const c_void, // *mut CFArrayRef
    ) -> AXError;

    fn AXUIElementCopyActionNames(
        element: AXUIElementRef,
        names: *mut *const c_void, // *mut CFArrayRef
    ) -> AXError;

    fn AXUIElementPerformAction(
        element: AXUIElementRef,
        action: *const c_void, // CFStringRef
    ) -> AXError;

    fn AXUIElementSetAttributeValue(
        element: AXUIElementRef,
        attribute: *const c_void, // CFStringRef
        value: *const c_void,
    ) -> AXError;

    fn AXUIElementCopyElementAtPosition(
        application: AXUIElementRef,
        x: f32,
        y: f32,
        element: *mut AXUIElementRef,
    ) -> AXError;

    fn CFRelease(cf: *const c_void);
    fn CFRetain(cf: *const c_void) -> *const c_void;
    fn CFGetTypeID(cf: *const c_void) -> u64;
    fn CFStringGetTypeID() -> u64;
    fn CFBooleanGetTypeID() -> u64;
    fn CFNumberGetTypeID() -> u64;
    fn CFArrayGetTypeID() -> u64;
    fn AXUIElementGetTypeID() -> u64;

    fn CFArrayGetCount(theArray: *const c_void) -> i64;
    fn CFArrayGetValueAtIndex(theArray: *const c_void, idx: i64) -> *const c_void;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFBooleanTrue: *const c_void;
}

// ──────────── AX 属性名常量 ────────────

fn ax_attr(name: &str) -> CFString {
    CFString::new(name)
}

// ──────────── 安全包装 ────────────

/// RAII wrapper for AXUIElementRef
struct AXElement {
    raw: AXUIElementRef,
}

impl AXElement {
    fn from_raw(_raw: AXUIElementRef) -> Option<Self> {
        if _raw.is_null() {
            None
        } else {
            Some(Self { raw: _raw })
        }
    }

    fn from_pid(pid: i32) -> Self {
        unsafe {
            let raw = AXUIElementCreateApplication(pid);
            Self { raw }
        }
    }

    fn system_wide() -> Self {
        unsafe {
            let raw = AXUIElementCreateSystemWide();
            Self { raw }
        }
    }

    fn get_attribute_string(&self, attr: &str) -> Option<String> {
        unsafe {
            let cf_attr = ax_attr(attr);
            let mut value: *const c_void = ptr::null();
            let err = AXUIElementCopyAttributeValue(self.raw, cf_attr.as_concrete_TypeRef() as _, &mut value);
            if err != kAXErrorSuccess || value.is_null() {
                return None;
            }
            let type_id = CFGetTypeID(value);
            let result = if type_id == CFStringGetTypeID() {
                let cf_str = CFString::wrap_under_create_rule(value as _);
                Some(cf_str.to_string())
            } else {
                None
            };
            if result.is_none() {
                CFRelease(value);
            }
            result
        }
    }

    fn get_attribute_bool(&self, attr: &str) -> Option<bool> {
        unsafe {
            let cf_attr = ax_attr(attr);
            let mut value: *const c_void = ptr::null();
            let err = AXUIElementCopyAttributeValue(self.raw, cf_attr.as_concrete_TypeRef() as _, &mut value);
            if err != kAXErrorSuccess || value.is_null() {
                return None;
            }
            let type_id = CFGetTypeID(value);
            let result = if type_id == CFBooleanGetTypeID() {
                Some(value == kCFBooleanTrue)
            } else {
                None
            };
            CFRelease(value);
            result
        }
    }

    fn get_attribute_number(&self, attr: &str) -> Option<f64> {
        unsafe {
            let cf_attr = ax_attr(attr);
            let mut value: *const c_void = ptr::null();
            let err = AXUIElementCopyAttributeValue(self.raw, cf_attr.as_concrete_TypeRef() as _, &mut value);
            if err != kAXErrorSuccess || value.is_null() {
                return None;
            }
            let type_id = CFGetTypeID(value);
            let result = if type_id == CFNumberGetTypeID() {
                let cf_num = CFNumber::wrap_under_create_rule(value as _);
                cf_num.to_f64()
            } else {
                None
            };
            if result.is_none() {
                CFRelease(value);
            }
            result
        }
    }

    fn get_position(&self) -> (Option<f64>, Option<f64>) {
        unsafe {
            let cf_attr = ax_attr("AXPosition");
            let mut value: *const c_void = ptr::null();
            let err = AXUIElementCopyAttributeValue(self.raw, cf_attr.as_concrete_TypeRef() as _, &mut value);
            if err != kAXErrorSuccess || value.is_null() {
                return (None, None);
            }
            // AXPosition is an AXValue (CGPoint)
            let mut point: [f64; 2] = [0.0, 0.0];
            let ok = AXValueGetValue(value, 1 /* kAXValueCGPointType */, point.as_mut_ptr() as *mut c_void);
            CFRelease(value);
            if ok {
                (Some(point[0]), Some(point[1]))
            } else {
                (None, None)
            }
        }
    }

    fn get_size(&self) -> (Option<f64>, Option<f64>) {
        unsafe {
            let cf_attr = ax_attr("AXSize");
            let mut value: *const c_void = ptr::null();
            let err = AXUIElementCopyAttributeValue(self.raw, cf_attr.as_concrete_TypeRef() as _, &mut value);
            if err != kAXErrorSuccess || value.is_null() {
                return (None, None);
            }
            // AXSize is an AXValue (CGSize)
            let mut size: [f64; 2] = [0.0, 0.0];
            let ok = AXValueGetValue(value, 2 /* kAXValueCGSizeType */, size.as_mut_ptr() as *mut c_void);
            CFRelease(value);
            if ok {
                (Some(size[0]), Some(size[1]))
            } else {
                (None, None)
            }
        }
    }

    fn get_children(&self) -> Vec<AXElement> {
        unsafe {
            let cf_attr = ax_attr("AXChildren");
            let mut value: *const c_void = ptr::null();
            let err = AXUIElementCopyAttributeValue(self.raw, cf_attr.as_concrete_TypeRef() as _, &mut value);
            if err != kAXErrorSuccess || value.is_null() {
                return Vec::new();
            }
            let type_id = CFGetTypeID(value);
            if type_id != CFArrayGetTypeID() {
                CFRelease(value);
                return Vec::new();
            }
            let count = CFArrayGetCount(value);
            let mut children = Vec::with_capacity(count as usize);
            for i in 0..count {
                let child_ref = CFArrayGetValueAtIndex(value, i);
                if !child_ref.is_null() {
                    CFRetain(child_ref);
                    children.push(AXElement { raw: child_ref });
                }
            }
            CFRelease(value);
            children
        }
    }

    fn get_actions(&self) -> Vec<String> {
        unsafe {
            let mut names: *const c_void = ptr::null();
            let err = AXUIElementCopyActionNames(self.raw, &mut names);
            if err != kAXErrorSuccess || names.is_null() {
                return Vec::new();
            }
            let count = CFArrayGetCount(names);
            let mut actions = Vec::with_capacity(count as usize);
            for i in 0..count {
                let name_ref = CFArrayGetValueAtIndex(names, i);
                if !name_ref.is_null() {
                    let cf_str = CFString::wrap_under_get_rule(name_ref as _);
                    actions.push(cf_str.to_string());
                }
            }
            CFRelease(names);
            actions
        }
    }

    fn perform_action(&self, action: &str) -> Result<(), AXError> {
        unsafe {
            let cf_action = ax_attr(action);
            let err = AXUIElementPerformAction(self.raw, cf_action.as_concrete_TypeRef() as _);
            if err == kAXErrorSuccess {
                Ok(())
            } else {
                Err(err)
            }
        }
    }

    fn set_value(&self, value: &str) -> Result<(), AXError> {
        unsafe {
            let cf_attr = ax_attr("AXValue");
            let cf_value = CFString::new(value);
            let err = AXUIElementSetAttributeValue(
                self.raw,
                cf_attr.as_concrete_TypeRef() as _,
                cf_value.as_concrete_TypeRef() as _,
            );
            if err == kAXErrorSuccess {
                Ok(())
            } else {
                Err(err)
            }
        }
    }

    fn element_at_position(&self, x: f32, y: f32) -> Option<AXElement> {
        unsafe {
            let mut element: AXUIElementRef = ptr::null();
            let err = AXUIElementCopyElementAtPosition(self.raw, x, y, &mut element);
            if err == kAXErrorSuccess && !element.is_null() {
                Some(AXElement { raw: element })
            } else {
                None
            }
        }
    }

    fn to_info(&self, path: &str, max_depth: i32, current_depth: i32, include_invisible: bool) -> AXElementInfo {
        let role = self.get_attribute_string("AXRole").unwrap_or_default();
        let role_description = self.get_attribute_string("AXRoleDescription");
        let title = self.get_attribute_string("AXTitle");
        let value_str = self.get_attribute_string("AXValue");
        let description = self.get_attribute_string("AXDescription");
        let enabled = self.get_attribute_bool("AXEnabled");
        let focused = self.get_attribute_bool("AXFocused");
        let (x, y) = self.get_position();
        let (width, height) = self.get_size();
        let actions = self.get_actions();

        let children_elements = self.get_children();
        let children_count = children_elements.len() as i32;

        let children = if current_depth < max_depth {
            let mut role_counters: std::collections::HashMap<String, i32> = std::collections::HashMap::new();
            children_elements
                .iter()
                .filter(|child| {
                    if include_invisible {
                        return true;
                    }
                    // 跳过不可见元素
                    // 检查 AXHidden 属性
                    child.get_attribute_bool("AXHidden").map_or(true, |h| !h)
                })
                .map(|child| {
                    let child_role = child.get_attribute_string("AXRole").unwrap_or_else(|| "Unknown".to_string());
                    let idx = role_counters.entry(child_role.clone()).or_insert(0);
                    let child_path = format!("{}/{}[{}]", path, child_role, idx);
                    *role_counters.get_mut(&child_role).unwrap() += 1;
                    child.to_info(&child_path, max_depth, current_depth + 1, include_invisible)
                })
                .collect()
        } else {
            Vec::new()
        };

        AXElementInfo {
            path: path.to_string(),
            role,
            role_description,
            title,
            value: value_str,
            description,
            enabled,
            focused,
            x,
            y,
            width,
            height,
            actions,
            children_count,
            children,
        }
    }
}

impl Drop for AXElement {
    fn drop(&mut self) {
        if !self.raw.is_null() {
            unsafe { CFRelease(self.raw) };
        }
    }
}

// AXValue API
extern "C" {
    fn AXValueGetValue(value: *const c_void, value_type: u32, value_ptr: *mut c_void) -> bool;
}

// ──────────── NSWorkspace / 进程枚举 ────────────

extern "C" {
    // 我们用 CGWindowListCopyWindowInfo 来获取窗口归属的 PID
    fn CGWindowListCopyWindowInfo(option: u32, relativeToWindow: u32) -> *const c_void;
}

// ──────────── 公开 API ────────────

pub fn ax_check_permission(prompt: bool) -> bool {
    unsafe {
        if prompt {
            // 创建 options dict with kAXTrustedCheckOptionPrompt = true
            let key = CFString::new("AXTrustedCheckOptionPrompt");
            let opts = core_foundation::dictionary::CFDictionary::from_CFType_pairs(&[
                (key.as_CFType(), CFBoolean::true_value().as_CFType()),
            ]);
            AXIsProcessTrustedWithOptions(opts.as_concrete_TypeRef() as _)
        } else {
            AXIsProcessTrusted()
        }
    }
}

pub fn ax_get_ui_tree(pid: i32, max_depth: i32, include_invisible: bool) -> Result<Vec<AXElementInfo>, String> {
    if !ax_check_permission(false) {
        return Err("未获得辅助功能权限。请前往: 系统设置 → 隐私与安全性 → 辅助功能".to_string());
    }

    let app = AXElement::from_pid(pid);
    let windows = app.get_children();

    if windows.is_empty() {
        // 可能是应用本身就是根元素
        let info = app.to_info("AXApplication", max_depth, 0, include_invisible);
        return Ok(vec![info]);
    }

    let mut result = Vec::new();
    for (i, win) in windows.iter().enumerate() {
        let role = win.get_attribute_string("AXRole").unwrap_or_else(|| "AXWindow".to_string());
        let path = format!("{}[{}]", role, i);
        result.push(win.to_info(&path, max_depth, 0, include_invisible));
    }

    Ok(result)
}

pub fn ax_find_elements(
    pid: i32,
    role_filter: Option<String>,
    title_filter: Option<String>,
    max_depth: i32,
) -> Result<Vec<AXElementInfo>, String> {
    if !ax_check_permission(false) {
        return Err("未获得辅助功能权限".to_string());
    }

    let app = AXElement::from_pid(pid);
    let mut results = Vec::new();

    fn search(
        element: &AXElement,
        path: &str,
        role_filter: &Option<String>,
        title_filter: &Option<String>,
        max_depth: i32,
        current_depth: i32,
        results: &mut Vec<AXElementInfo>,
        _role_counters: &mut std::collections::HashMap<String, i32>,
    ) {
        if current_depth > max_depth {
            return;
        }

        let role = element.get_attribute_string("AXRole").unwrap_or_default();
        let title = element.get_attribute_string("AXTitle");

        let role_match = role_filter.as_ref().map_or(true, |f| role.contains(f));
        let title_match = title_filter.as_ref().map_or(true, |f| {
            title.as_ref().map_or(false, |t| t.to_lowercase().contains(&f.to_lowercase()))
        });

        if role_match && title_match && current_depth > 0 {
            results.push(element.to_info(path, 0, 0, false));
        }

        let children = element.get_children();
        let mut child_counters: std::collections::HashMap<String, i32> = std::collections::HashMap::new();
        for child in &children {
            let child_role = child.get_attribute_string("AXRole").unwrap_or_else(|| "Unknown".to_string());
            let idx = child_counters.entry(child_role.clone()).or_insert(0);
            let child_path = format!("{}/{}[{}]", path, child_role, idx);
            *child_counters.get_mut(&child_role).unwrap() += 1;
            search(child, &child_path, role_filter, title_filter, max_depth, current_depth + 1, results, &mut child_counters);
        }
    }

    let mut counters = std::collections::HashMap::new();
    search(&app, "AXApplication", &role_filter, &title_filter, max_depth, 0, &mut results, &mut counters);

    Ok(results)
}

pub fn ax_perform_action(pid: i32, element_path: &str, action: &str) -> Result<bool, String> {
    if !ax_check_permission(false) {
        return Err("未获得辅助功能权限".to_string());
    }

    let element = resolve_element_by_path(pid, element_path)?;
    element
        .perform_action(action)
        .map(|_| true)
        .map_err(|code| format!("执行操作 {} 失败，错误码: {}", action, code))
}

pub fn ax_set_value(pid: i32, element_path: &str, value: &str) -> Result<bool, String> {
    if !ax_check_permission(false) {
        return Err("未获得辅助功能权限".to_string());
    }

    let element = resolve_element_by_path(pid, element_path)?;
    element
        .set_value(value)
        .map(|_| true)
        .map_err(|code| format!("设置值失败，错误码: {}", code))
}

pub fn ax_element_at_position(pid: i32, x: f64, y: f64) -> Result<Option<AXElementInfo>, String> {
    if !ax_check_permission(false) {
        return Err("未获得辅助功能权限".to_string());
    }

    let app = if pid == 0 {
        AXElement::system_wide()
    } else {
        AXElement::from_pid(pid)
    };

    match app.element_at_position(x as f32, y as f32) {
        Some(element) => {
            let info = element.to_info("element_at_position", 0, 0, false);
            Ok(Some(info))
        }
        None => Ok(None),
    }
}

pub fn ax_list_processes() -> Result<Vec<AXProcessInfo>, String> {
    // 使用 NSWorkspace 获取运行的应用
    // 通过 CGWindowListCopyWindowInfo 获取有窗口的进程
    unsafe {
        let kCGWindowListOptionOnScreenOnly: u32 = 1;
        let kCGWindowListExcludeDesktopElements: u32 = 16;
        let options = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements;

        let window_list = CGWindowListCopyWindowInfo(options, 0);
        if window_list.is_null() {
            return Ok(Vec::new());
        }

        let count = CFArrayGetCount(window_list);
        let mut seen_pids = std::collections::HashSet::new();
        let mut processes = Vec::new();

        for i in 0..count {
            let dict = CFArrayGetValueAtIndex(window_list, i);
            if dict.is_null() {
                continue;
            }

            // 读取 kCGWindowOwnerPID
            let pid_key = CFString::new("kCGWindowOwnerPID");
            let name_key = CFString::new("kCGWindowOwnerName");

            let mut pid_val: *const c_void = ptr::null();
            let has_pid = CFDictionaryGetValueIfPresent(
                dict as _,
                pid_key.as_concrete_TypeRef() as _,
                &mut pid_val,
            );
            if !has_pid || pid_val.is_null() {
                continue;
            }

            let cf_pid = CFNumber::wrap_under_get_rule(pid_val as _);
            let pid = cf_pid.to_i32().unwrap_or(0);
            if pid <= 0 || !seen_pids.insert(pid) {
                continue;
            }

            let mut name_val: *const c_void = ptr::null();
            let has_name = CFDictionaryGetValueIfPresent(
                dict as _,
                name_key.as_concrete_TypeRef() as _,
                &mut name_val,
            );
            let name = if has_name && !name_val.is_null() {
                let cf_str = CFString::wrap_under_get_rule(name_val as _);
                cf_str.to_string()
            } else {
                continue;
            };

            processes.push(AXProcessInfo {
                pid,
                name,
                bundle_id: None, // 可以通过 NSRunningApplication 获取，但需要 ObjC bridge
            });
        }

        CFRelease(window_list);
        Ok(processes)
    }
}

// ──────────── 路径解析 ────────────

/// 根据路径字符串定位 UI 元素
///
/// 路径格式: "AXWindow[0]/AXGroup[1]/AXButton[0]"
/// 或 "AXApplication/AXWindow[0]/AXGroup[1]/AXButton[0]"
fn resolve_element_by_path(pid: i32, path: &str) -> Result<AXElement, String> {
    let app = AXElement::from_pid(pid);

    let segments: Vec<&str> = path.split('/').collect();
    let start_idx = if segments.first().map_or(false, |s| s.starts_with("AXApplication")) {
        1 // 跳过 AXApplication 前缀
    } else {
        0
    };

    let mut current_children = app.get_children();
    let mut current_element_raw: AXUIElementRef = ptr::null();

    for seg in &segments[start_idx..] {
        let (role, index) = parse_path_segment(seg)?;

        // 在 current_children 中找第 index 个 role 匹配的元素
        let mut match_count = 0;
        let mut found = false;
        for child in &current_children {
            let child_role = child.get_attribute_string("AXRole").unwrap_or_default();
            if child_role == role {
                if match_count == index {
                    // 找到了，保留引用并继续下一层
                    unsafe {
                        if !current_element_raw.is_null() {
                            // 之前的引用已被 current_children drop 管理
                        }
                        CFRetain(child.raw);
                        current_element_raw = child.raw;
                    }
                    found = true;
                    break;
                }
                match_count += 1;
            }
        }

        if !found {
            return Err(format!(
                "路径解析失败: 在当前层级未找到 {}[{}] (找到 {} 个 {} 元素)",
                role, index, match_count, role
            ));
        }

        // 获取下一层的子元素
        let next = AXElement { raw: current_element_raw };
        current_children = next.get_children();
        // 不 drop next，因为我们需要它的 raw 指针
        std::mem::forget(next);
    }

    if current_element_raw.is_null() {
        Err("路径为空或无法解析".to_string())
    } else {
        Ok(AXElement { raw: current_element_raw })
    }
}

/// 解析路径段，如 "AXButton[0]" → ("AXButton", 0)
fn parse_path_segment(segment: &str) -> Result<(String, usize), String> {
    if let Some(bracket_pos) = segment.find('[') {
        if !segment.ends_with(']') {
            return Err(format!("路径段格式无效: {}", segment));
        }
        let role = segment[..bracket_pos].to_string();
        let index_str = &segment[bracket_pos + 1..segment.len() - 1];
        let index: usize = index_str
            .parse()
            .map_err(|_| format!("路径段索引无效: {}", segment))?;
        Ok((role, index))
    } else {
        // 没有索引，默认 [0]
        Ok((segment.to_string(), 0))
    }
}

// CFDictionary helper - direct FFI for functions not in core_foundation crate
extern "C" {
    fn CFDictionaryGetValueIfPresent(
        theDict: *const c_void,
        key: *const c_void,
        value: *mut *const c_void,
    ) -> bool;
}
