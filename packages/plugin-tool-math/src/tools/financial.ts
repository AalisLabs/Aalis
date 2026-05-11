import type { Context } from '@aalis/core';

export function registerFinancialTools(ctx: Context): void {
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'math_financial',
        description:
          '金融数学工具。支持: compound_interest(复利计算)、simple_interest(单利)、loan_payment(贷款月供-等额本息)、loan_payment_principal(等额本金)、present_value(现值)、future_value(终值)、npv(净现值)、irr(内部收益率)、roi(投资回报率)、cagr(年均复合增长率)、break_even(盈亏平衡点)、depreciation(折旧-直线法/双倍余额法)',
        parameters: {
          type: 'object',
          properties: {
            operation: { type: 'string', description: '操作类型' },
            principal: { type: 'number', description: '本金/初始金额' },
            rate: { type: 'number', description: '年利率（小数形式，如 0.05 表示 5%）' },
            periods: { type: 'number', description: '期数（年/月，视操作而定）' },
            periodsPerYear: { type: 'number', description: '每年复利次数（默认 12）' },
            payment: { type: 'number', description: '每期付款' },
            cashflows: { type: 'array', items: { type: 'number' }, description: '现金流序列（NPV/IRR）' },
            initialInvestment: { type: 'number', description: '初始投资' },
            finalValue: { type: 'number', description: '最终价值' },
            fixedCosts: { type: 'number', description: '固定成本' },
            pricePerUnit: { type: 'number', description: '单价' },
            costPerUnit: { type: 'number', description: '单位变动成本' },
            assetCost: { type: 'number', description: '资产原值' },
            salvageValue: { type: 'number', description: '残值' },
            usefulLife: { type: 'number', description: '使用年限' },
            method: { type: 'string', description: '折旧方法 (straight_line / double_declining)' },
          },
          required: ['operation'],
        },
      },
    },
    handler: async args => {
      try {
        const op = String(args.operation);

        switch (op) {
          case 'compound_interest': {
            const P = Number(args.principal ?? 0);
            const r = Number(args.rate ?? 0);
            const t = Number(args.periods ?? 0);
            const n = Number(args.periodsPerYear ?? 12);
            const A = P * (1 + r / n) ** (n * t);
            return JSON.stringify({
              principal: P,
              rate: r,
              periods: t,
              periodsPerYear: n,
              futureValue: A,
              interestEarned: A - P,
            });
          }

          case 'simple_interest': {
            const P = Number(args.principal ?? 0);
            const r = Number(args.rate ?? 0);
            const t = Number(args.periods ?? 0);
            const interest = P * r * t;
            return JSON.stringify({
              principal: P,
              rate: r,
              periods: t,
              interest,
              total: P + interest,
            });
          }

          case 'loan_payment': {
            // 等额本息
            const P = Number(args.principal ?? 0);
            const annualRate = Number(args.rate ?? 0);
            const months = Math.round(Number(args.periods ?? 0));
            const r = annualRate / 12;
            if (r === 0) {
              const monthly = P / months;
              return JSON.stringify({ monthlyPayment: monthly, totalPayment: P, totalInterest: 0 });
            }
            const monthly = (P * r * (1 + r) ** months) / ((1 + r) ** months - 1);
            const total = monthly * months;
            return JSON.stringify({
              monthlyPayment: monthly,
              totalPayment: total,
              totalInterest: total - P,
            });
          }

          case 'loan_payment_principal': {
            // 等额本金
            const P = Number(args.principal ?? 0);
            const annualRate = Number(args.rate ?? 0);
            const months = Math.round(Number(args.periods ?? 0));
            const r = annualRate / 12;
            const principalPart = P / months;
            let totalInterest = 0;
            const schedule: {
              month: number;
              payment: number;
              principal: number;
              interest: number;
              remaining: number;
            }[] = [];
            for (let i = 1; i <= months; i++) {
              const remaining = P - principalPart * (i - 1);
              const interest = remaining * r;
              totalInterest += interest;
              if (i <= 12 || i === months) {
                // 只输出前12个月和最后一个月
                schedule.push({
                  month: i,
                  payment: principalPart + interest,
                  principal: principalPart,
                  interest,
                  remaining: remaining - principalPart,
                });
              }
            }
            return JSON.stringify({
              firstMonthPayment: principalPart + P * r,
              lastMonthPayment: principalPart + principalPart * r,
              totalPayment: P + totalInterest,
              totalInterest,
              schedule,
            });
          }

          case 'present_value': {
            const FV = Number(args.finalValue ?? args.payment ?? 0);
            const r = Number(args.rate ?? 0);
            const t = Number(args.periods ?? 0);
            const PV = FV / (1 + r) ** t;
            return JSON.stringify({ futureValue: FV, rate: r, periods: t, presentValue: PV });
          }

          case 'future_value': {
            const PV = Number(args.principal ?? 0);
            const r = Number(args.rate ?? 0);
            const t = Number(args.periods ?? 0);
            const FV = PV * (1 + r) ** t;
            return JSON.stringify({ presentValue: PV, rate: r, periods: t, futureValue: FV });
          }

          case 'npv': {
            const cashflows = args.cashflows as number[] | undefined;
            const r = Number(args.rate ?? 0);
            if (!cashflows || cashflows.length === 0) {
              return JSON.stringify({ error: '需要 cashflows 数组' });
            }
            let npv = 0;
            for (let i = 0; i < cashflows.length; i++) {
              npv += cashflows[i] / (1 + r) ** i;
            }
            return JSON.stringify({ rate: r, npv, cashflows: cashflows.length });
          }

          case 'irr': {
            const cashflows = args.cashflows as number[] | undefined;
            if (!cashflows || cashflows.length < 2) {
              return JSON.stringify({ error: '至少需要 2 个现金流' });
            }
            const irr = computeIRR(cashflows);
            if (irr === null) return JSON.stringify({ error: '无法收敛计算 IRR' });
            return JSON.stringify({ irr, irrPercent: `${(irr * 100).toFixed(4)}%` });
          }

          case 'roi': {
            const initial = Number(args.initialInvestment ?? args.principal ?? 0);
            const final_ = Number(args.finalValue ?? 0);
            if (initial === 0) return JSON.stringify({ error: '初始投资不能为 0' });
            const roi = (final_ - initial) / initial;
            return JSON.stringify({
              initialInvestment: initial,
              finalValue: final_,
              roi,
              roiPercent: `${(roi * 100).toFixed(4)}%`,
            });
          }

          case 'cagr': {
            const begin = Number(args.principal ?? args.initialInvestment ?? 0);
            const end = Number(args.finalValue ?? 0);
            const t = Number(args.periods ?? 0);
            if (begin <= 0 || t <= 0) return JSON.stringify({ error: '初始值和期数必须为正数' });
            const cagr = (end / begin) ** (1 / t) - 1;
            return JSON.stringify({
              beginValue: begin,
              endValue: end,
              periods: t,
              cagr,
              cagrPercent: `${(cagr * 100).toFixed(4)}%`,
            });
          }

          case 'break_even': {
            const fc = Number(args.fixedCosts ?? 0);
            const price = Number(args.pricePerUnit ?? 0);
            const vc = Number(args.costPerUnit ?? 0);
            if (price <= vc) return JSON.stringify({ error: '单价必须大于单位变动成本' });
            const units = fc / (price - vc);
            const revenue = units * price;
            return JSON.stringify({ breakEvenUnits: units, breakEvenRevenue: revenue });
          }

          case 'depreciation': {
            const cost = Number(args.assetCost ?? 0);
            const salvage = Number(args.salvageValue ?? 0);
            const life = Math.round(Number(args.usefulLife ?? 0));
            const method = String(args.method ?? 'straight_line');

            if (life <= 0) return JSON.stringify({ error: '使用年限必须为正数' });

            if (method === 'straight_line') {
              const annual = (cost - salvage) / life;
              const schedule = Array.from({ length: life }, (_, i) => ({
                year: i + 1,
                depreciation: annual,
                bookValue: cost - annual * (i + 1),
              }));
              return JSON.stringify({ method: '直线法', annualDepreciation: annual, schedule });
            }

            if (method === 'double_declining') {
              const rate = 2 / life;
              const schedule: { year: number; depreciation: number; bookValue: number }[] = [];
              let bv = cost;
              for (let y = 1; y <= life; y++) {
                let dep = bv * rate;
                if (bv - dep < salvage) dep = bv - salvage;
                if (dep < 0) dep = 0;
                bv -= dep;
                schedule.push({ year: y, depreciation: dep, bookValue: bv });
              }
              return JSON.stringify({ method: '双倍余额递减法', schedule });
            }

            return JSON.stringify({ error: `未知折旧方法: ${method}` });
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

// Newton-Raphson 法求 IRR
function computeIRR(cashflows: number[]): number | null {
  let rate = 0.1;
  for (let iter = 0; iter < 1000; iter++) {
    let npv = 0,
      dnpv = 0;
    for (let i = 0; i < cashflows.length; i++) {
      const pow = (1 + rate) ** i;
      npv += cashflows[i] / pow;
      dnpv -= (i * cashflows[i]) / (pow * (1 + rate));
    }
    if (Math.abs(dnpv) < 1e-15) return null;
    const newRate = rate - npv / dnpv;
    if (Math.abs(newRate - rate) < 1e-10) return newRate;
    rate = newRate;
  }
  return null;
}
