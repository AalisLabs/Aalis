# plugin-tool-math — 数学计算工具集

**包名**: `@aalis/plugin-tool-math`  
**源码**: `packages/plugin-tool-math/src/index.ts`

## 概述

为 AI 提供数值与符号计算工具，覆盖 11 个类别，每个类别对应一个工具，统一注册到 `math` 工具组，可按类别单独开关。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-tool-math',
  displayName: '数学工具',
  subsystem: 'tools',
  apply(caps) { /* 见源码 */ },
  uses: {
    tools: optional(tools),
    config,
    logger,
  },
});
```

## 配置

各类别独立开关，关闭后不注册该类别下的工具。

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `evaluate` | object | — | 表达式计算 |
| `evaluate.enabled` | boolean | `true` | 启用表达式计算工具 |
| `statistics` | object | — | 统计分析 |
| `statistics.enabled` | boolean | `true` | 启用统计分析工具 |
| `matrix` | object | — | 矩阵运算 |
| `matrix.enabled` | boolean | `true` | 启用矩阵运算工具 |
| `numberTheory` | object | — | 数论与组合 |
| `numberTheory.enabled` | boolean | `true` | 启用数论工具 |
| `geometry` | object | — | 几何计算 |
| `geometry.enabled` | boolean | `true` | 启用几何计算工具 |
| `conversion` | object | — | 单位换算 |
| `conversion.enabled` | boolean | `true` | 启用单位换算工具 |
| `financial` | object | — | 金融数学 |
| `financial.enabled` | boolean | `true` | 启用金融数学工具 |
| `calculus` | object | — | 微积分 |
| `calculus.enabled` | boolean | `true` | 启用微积分工具 |
| `equation` | object | — | 方程求解 |
| `equation.enabled` | boolean | `true` | 启用方程求解工具 |
| `baseConvert` | object | — | 进制转换 |
| `baseConvert.enabled` | boolean | `true` | 启用进制转换工具 |
| `symbolic` | object | — | 符号代数 (mathjs) |
| `symbolic.enabled` | boolean | `true` | 启用符号计算工具：符号求导、化简、有理化、LaTeX 输出等，基于 mathjs |

## 计算类别

| 类别 | 工具 | 说明 |
|---|---|---|
| 表达式求值 | `math_eval` | 数学表达式解析与计算 |
| 统计分析 | `math_statistics` | 均值/中位数/方差/标准差等 |
| 矩阵运算 | `math_matrix` | 矩阵乘法/转置/行列式/逆矩阵 |
| 数论 | `math_number_theory` | 质数判定/因数分解/GCD/LCM |
| 几何计算 | `math_geometry` | 面积/体积/距离/角度 |
| 单位转换 | `math_unit_convert` | 长度/质量/温度/时间等单位互转 |
| 金融计算 | `math_financial` | 复利/单利/贷款月供（等额本息、等额本金）/现值/终值/NPV/IRR/ROI/CAGR/盈亏平衡/折旧 |
| 微积分 | `math_calculus` | 数值导数（1–2 阶）/数值定积分（Simpson 法）/方程求根（牛顿法、二分法）/数列极限近似。积分分段数最多 1000000；单次调用计算超过 2 秒即中止并返回错误 |
| 方程求解 | `math_equation` | 一元一次/二次/三次方程、线性方程组（高斯消元）、比例式 |
| 进制转换 | `math_base_convert` | 2–36 任意进制互转、位运算（AND/OR/XOR/NOT/SHL/SHR）、IEEE 754 浮点数分析 |
| 符号代数 | `math_symbolic` | 符号求导/化简/有理化/展开/LaTeX 输出，基于 mathjs |
