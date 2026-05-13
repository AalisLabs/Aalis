import type { ScopedToolService } from '@aalis/plugin-tools-api';
import { listFunctions, safeEval } from '../lib/expression.js';

export function registerEvaluateTools(tools: ScopedToolService): void {
  const funcs = listFunctions();
  const funcList = [
    `常量: ${funcs.constants.join(', ')}`,
    `一元函数: ${funcs.functions1.join(', ')}`,
    `二元函数: ${funcs.functions2.join(', ')}`,
    `多参数函数: ${funcs.functionsVar.join(', ')}`,
  ].join('\n');

  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'math_eval',
        description: `安全地计算数学表达式。支持四则运算、幂运算(^)、括号、比较。\n可用资源:\n${funcList}\n示例: "sqrt(2) * sin(pi/4)", "log_base(1024, 2)", "comb(10, 3)", "factorial(10)"`,
        parameters: {
          type: 'object',
          properties: {
            expression: {
              type: 'string',
              description: '要计算的数学表达式',
            },
          },
          required: ['expression'],
        },
      },
    },
    handler: async args => {
      const expr = String(args.expression ?? '');
      try {
        const result = safeEval(expr);
        return JSON.stringify({
          expression: expr,
          result,
          resultStr: Number.isInteger(result)
            ? String(result)
            : result.toPrecision(15).replace(/0+$/, '').replace(/\.$/, ''),
        });
      } catch (err: unknown) {
        return JSON.stringify({ error: (err as Error).message, expression: expr });
      }
    },
  });
}
