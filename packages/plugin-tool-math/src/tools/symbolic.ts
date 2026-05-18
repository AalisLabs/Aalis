import type { ScopedToolService } from '@aalis/plugin-tools-api';
import { all, create, type MathNode } from 'mathjs';

const math = create(all, {
  // 数值精度保持默认；符号操作走 expression tree 不依赖该值
  number: 'number',
});

/**
 * 符号计算工具（基于 mathjs）。
 *
 * 弥补 calculus 工具只能做数值近似的短板：求导、化简、有理化、变量代入、LaTeX 输出
 * 都是 LLM 自己手算最容易出错的部分（链式法则、分式通分、负号传播），交给 mathjs
 * 一次性算准并以多种形态（普通字符串 + LaTeX）返回。
 *
 * 不覆盖：
 * - 符号定积分（mathjs 不支持，需要 SymPy）
 * - 多元方程 solve（mathjs 只有数值 lusolve 和单变量根）
 * - 极限的 ε-δ 推理（仍需 LLM 自己分析路径）
 */
export function registerSymbolicTools(tools: ScopedToolService): void {
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'math_symbolic',
        description: [
          '符号代数工具（mathjs 解析树）。专治"链式法则容易出错、分式通分容易漏负号"等场景。',
          '操作: derivative(符号求导), simplify(化简), rationalize(分式合并为最简有理式),',
          'expand(展开多项式), substitute(变量代入后化简), to_latex(转 LaTeX), evaluate(给定变量值求数值).',
          '局限: 不支持符号定积分、不支持多元方程 solve、不做极限推理。',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            operation: {
              type: 'string',
              enum: ['derivative', 'simplify', 'rationalize', 'expand', 'substitute', 'to_latex', 'evaluate'],
              description: '操作类型',
            },
            expression: {
              type: 'string',
              description: '数学表达式，例: "x^2 + sin(x*y)"。变量名可任意 (x, y, t, theta...)，函数名同 mathjs。',
            },
            variable: {
              type: 'string',
              description: 'derivative 必填，求导自变量名 (如 "x")。其他操作忽略。',
            },
            order: {
              type: 'number',
              description: 'derivative 阶数，默认 1。高阶通过重复求导实现。',
            },
            scope: {
              type: 'object',
              description:
                'substitute / evaluate 用：变量赋值表。值可以是数字或字符串表达式 (substitute 时建议传字符串保留符号)。例: {"x": 1, "y": "t+1"}',
              additionalProperties: true,
            },
          },
          required: ['operation', 'expression'],
          additionalProperties: false,
        },
      },
    },
    handler: async args => {
      try {
        const op = String(args.operation);
        const expr = String(args.expression);
        if (!expr.trim()) return JSON.stringify({ error: 'expression 不能为空' });

        switch (op) {
          case 'derivative': {
            const variable = String(args.variable ?? '').trim();
            if (!variable) return JSON.stringify({ error: 'derivative 操作必须提供 variable' });
            const order = Math.max(1, Math.min(10, Math.floor(Number(args.order ?? 1))));
            let node: MathNode = math.parse(expr);
            for (let i = 0; i < order; i++) {
              node = math.derivative(node, variable);
            }
            const simplified = math.simplify(node);
            return JSON.stringify({
              expression: expr,
              variable,
              order,
              derivative: simplified.toString(),
              latex: simplified.toTex(),
            });
          }

          case 'simplify': {
            const node = math.simplify(expr);
            return JSON.stringify({
              expression: expr,
              simplified: node.toString(),
              latex: node.toTex(),
            });
          }

          case 'rationalize': {
            // mathjs rationalize 把多项式分式化为 P/Q 形式
            const result = math.rationalize(expr, {}, true) as {
              expression: MathNode;
              variables: string[];
              coefficients: number[];
            };
            return JSON.stringify({
              expression: expr,
              rationalized: result.expression.toString(),
              latex: result.expression.toTex(),
              variables: result.variables,
            });
          }

          case 'expand': {
            // mathjs 没有独立 expand，simplify 加 expand 友好规则
            const node = math.simplify(expr, [
              { l: 'n1*(n2+n3)', r: 'n1*n2 + n1*n3' },
              { l: '(n1+n2)*n3', r: 'n1*n3 + n2*n3' },
              { l: '(n1+n2)^2', r: 'n1^2 + 2*n1*n2 + n2^2' },
              ...math.simplify.rules,
            ]);
            return JSON.stringify({
              expression: expr,
              expanded: node.toString(),
              latex: node.toTex(),
            });
          }

          case 'substitute': {
            const scope = (args.scope ?? {}) as Record<string, unknown>;
            if (Object.keys(scope).length === 0) {
              return JSON.stringify({ error: 'substitute 需要 scope 提供变量赋值' });
            }
            // 把每个变量替换为对应表达式 (字符串或数字都允许)
            const subs: Record<string, MathNode> = {};
            for (const [k, v] of Object.entries(scope)) {
              subs[k] = typeof v === 'string' ? math.parse(v) : math.parse(String(v));
            }
            let node = math.parse(expr);
            node = node.transform(child => {
              if (child.type === 'SymbolNode' && (child as unknown as { name: string }).name in subs) {
                return subs[(child as unknown as { name: string }).name];
              }
              return child;
            });
            const simplified = math.simplify(node);
            return JSON.stringify({
              expression: expr,
              scope,
              substituted: simplified.toString(),
              latex: simplified.toTex(),
            });
          }

          case 'to_latex': {
            const node = math.parse(expr);
            return JSON.stringify({
              expression: expr,
              latex: node.toTex(),
              normalized: node.toString(),
            });
          }

          case 'evaluate': {
            const scope = (args.scope ?? {}) as Record<string, unknown>;
            // 数值化所有 scope 值（字符串也允许，mathjs 会自己求值）
            const numericScope: Record<string, number> = {};
            for (const [k, v] of Object.entries(scope)) {
              const evaluated = typeof v === 'number' ? v : math.evaluate(String(v));
              if (typeof evaluated !== 'number' || !Number.isFinite(evaluated)) {
                return JSON.stringify({ error: `scope.${k} 求值非有限数: ${evaluated}` });
              }
              numericScope[k] = evaluated;
            }
            const result = math.evaluate(expr, numericScope);
            return JSON.stringify({
              expression: expr,
              scope: numericScope,
              value: typeof result === 'number' ? result : String(result),
            });
          }

          default:
            return JSON.stringify({ error: `未知操作: ${op}` });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: `符号计算失败: ${message}` });
      }
    },
  });
}
