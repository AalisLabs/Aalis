import type { Context } from '@aalis/core';

export function registerBaseConvertTools(ctx: Context): void {
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'math_base_convert',
        description:
          '数制转换与位运算工具。支持: convert(任意进制转换 2-36)、to_all(一次输出二/八/十/十六进制)、bitwise(位运算 AND/OR/XOR/NOT/SHL/SHR)、float_analyze(IEEE 754 浮点数分析)',
        parameters: {
          type: 'object',
          properties: {
            operation: {
              type: 'string',
              description: '操作类型',
              enum: ['convert', 'to_all', 'bitwise', 'float_analyze'],
            },
            value: { type: 'string', description: '输入值（字符串形式）' },
            fromBase: { type: 'number', description: '源进制 (2-36，默认 10)' },
            toBase: { type: 'number', description: '目标进制 (2-36)' },
            // 位运算
            bitwiseOp: {
              type: 'string',
              description: '位运算: AND, OR, XOR, NOT, SHL, SHR',
              enum: ['AND', 'OR', 'XOR', 'NOT', 'SHL', 'SHR'],
            },
            value2: { type: 'string', description: '第二个操作数 / 移位位数' },
          },
          required: ['operation'],
        },
      },
    },
    handler: async args => {
      try {
        const op = String(args.operation);

        switch (op) {
          case 'convert': {
            const value = String(args.value ?? '0');
            const fromBase = Number(args.fromBase ?? 10);
            const toBase = Number(args.toBase ?? 10);
            if (fromBase < 2 || fromBase > 36 || toBase < 2 || toBase > 36) {
              return JSON.stringify({ error: '进制范围 2-36' });
            }
            const decimal = parseInt(value, fromBase);
            if (Number.isNaN(decimal)) return JSON.stringify({ error: `无效的 ${fromBase} 进制数: ${value}` });
            return JSON.stringify({
              input: value,
              fromBase,
              toBase,
              result: decimal.toString(toBase).toUpperCase(),
              decimal,
            });
          }

          case 'to_all': {
            const value = String(args.value ?? '0');
            const fromBase = Number(args.fromBase ?? 10);
            const decimal = parseInt(value, fromBase);
            if (Number.isNaN(decimal)) return JSON.stringify({ error: `无效的 ${fromBase} 进制数: ${value}` });
            return JSON.stringify({
              input: value,
              fromBase,
              decimal,
              binary: decimal.toString(2),
              octal: decimal.toString(8),
              hex: decimal.toString(16).toUpperCase(),
            });
          }

          case 'bitwise': {
            const bitwiseOp = String(args.bitwiseOp ?? 'AND');
            const a = parseInt(String(args.value ?? '0'), Number(args.fromBase ?? 10));
            if (Number.isNaN(a)) return JSON.stringify({ error: '无效的数值 a' });

            if (bitwiseOp === 'NOT') {
              const result = ~a;
              return JSON.stringify({
                operation: `NOT ${a}`,
                result,
                binary: `~${(a >>> 0).toString(2)} = ${(result >>> 0).toString(2)}`,
              });
            }

            const b = parseInt(String(args.value2 ?? '0'), Number(args.fromBase ?? 10));
            if (Number.isNaN(b)) return JSON.stringify({ error: '无效的数值 b' });

            let result: number;
            let symbol: string;
            switch (bitwiseOp) {
              case 'AND':
                result = a & b;
                symbol = '&';
                break;
              case 'OR':
                result = a | b;
                symbol = '|';
                break;
              case 'XOR':
                result = a ^ b;
                symbol = '^';
                break;
              case 'SHL':
                result = a << b;
                symbol = '<<';
                break;
              case 'SHR':
                result = a >> b;
                symbol = '>>';
                break;
              default:
                return JSON.stringify({ error: `未知位运算: ${bitwiseOp}` });
            }
            return JSON.stringify({
              operation: `${a} ${symbol} ${b}`,
              result,
              binaryA: (a >>> 0).toString(2),
              binaryB: (b >>> 0).toString(2),
              binaryResult: (result >>> 0).toString(2),
            });
          }

          case 'float_analyze': {
            const value = parseFloat(String(args.value ?? '0'));
            if (Number.isNaN(value)) return JSON.stringify({ error: '无效的浮点数' });
            const buf = new ArrayBuffer(8);
            new Float64Array(buf)[0] = value;
            const view = new DataView(buf);
            const hi = view.getUint32(0);
            const lo = view.getUint32(4);
            const bits = hi.toString(2).padStart(32, '0') + lo.toString(2).padStart(32, '0');
            const sign = bits[0];
            const exponent = bits.slice(1, 12);
            const mantissa = bits.slice(12);
            const expValue = parseInt(exponent, 2) - 1023;
            return JSON.stringify({
              value,
              sign: sign === '0' ? '+' : '-',
              exponentBits: exponent,
              exponentValue: expValue,
              mantissaBits: mantissa,
              isNaN: Number.isNaN(value),
              isFinite: Number.isFinite(value),
              isInteger: Number.isInteger(value),
              isSafeInteger: Number.isSafeInteger(value),
              epsilon: Number.EPSILON,
              maxSafeInteger: Number.MAX_SAFE_INTEGER,
            });
          }

          default:
            return JSON.stringify({ error: `未知操作: ${op}` });
        }
      } catch (err: unknown) {
        return JSON.stringify({ error: (err as Error).message });
      }
    },
  });
}
