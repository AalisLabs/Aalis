import type { ScopedToolService } from '@aalis/plugin-tools-api';

// ===== 单位转换映射 =====

interface UnitCategory {
  label: string;
  baseUnit: string;
  units: Record<string, { factor: number; label: string }>;
}

// 温度特殊处理，其他线性换算
const CATEGORIES: Record<string, UnitCategory> = {
  length: {
    label: '长度',
    baseUnit: 'm',
    units: {
      km: { factor: 1000, label: '千米' },
      m: { factor: 1, label: '米' },
      dm: { factor: 0.1, label: '分米' },
      cm: { factor: 0.01, label: '厘米' },
      mm: { factor: 0.001, label: '毫米' },
      um: { factor: 1e-6, label: '微米' },
      nm: { factor: 1e-9, label: '纳米' },
      mi: { factor: 1609.344, label: '英里' },
      yd: { factor: 0.9144, label: '码' },
      ft: { factor: 0.3048, label: '英尺' },
      in: { factor: 0.0254, label: '英寸' },
      nmi: { factor: 1852, label: '海里' },
      au: { factor: 1.495978707e11, label: '天文单位' },
      ly: { factor: 9.4607e15, label: '光年' },
      li: { factor: 500, label: '里' },
      zhang: { factor: 10 / 3, label: '丈' },
      chi: { factor: 1 / 3, label: '尺' },
      cun: { factor: 1 / 30, label: '寸' },
    },
  },
  mass: {
    label: '质量',
    baseUnit: 'kg',
    units: {
      t: { factor: 1000, label: '吨' },
      kg: { factor: 1, label: '千克' },
      g: { factor: 0.001, label: '克' },
      mg: { factor: 1e-6, label: '毫克' },
      ug: { factor: 1e-9, label: '微克' },
      lb: { factor: 0.453592, label: '磅' },
      oz: { factor: 0.0283495, label: '盎司' },
      st: { factor: 6.35029, label: '英石' },
      jin: { factor: 0.5, label: '斤' },
      liang: { factor: 0.05, label: '两' },
    },
  },
  area: {
    label: '面积',
    baseUnit: 'sqm',
    units: {
      sqkm: { factor: 1e6, label: '平方千米' },
      ha: { factor: 1e4, label: '公顷' },
      sqm: { factor: 1, label: '平方米' },
      sqcm: { factor: 1e-4, label: '平方厘米' },
      sqmm: { factor: 1e-6, label: '平方毫米' },
      sqmi: { factor: 2.59e6, label: '平方英里' },
      acre: { factor: 4046.86, label: '英亩' },
      sqft: { factor: 0.0929, label: '平方英尺' },
      sqin: { factor: 6.4516e-4, label: '平方英寸' },
      mu: { factor: 666.667, label: '亩' },
    },
  },
  volume: {
    label: '体积',
    baseUnit: 'L',
    units: {
      m3: { factor: 1000, label: '立方米' },
      L: { factor: 1, label: '升' },
      mL: { factor: 0.001, label: '毫升' },
      gal: { factor: 3.78541, label: '美制加仑' },
      qt: { factor: 0.946353, label: '夸脱' },
      pt: { factor: 0.473176, label: '品脱' },
      cup: { factor: 0.236588, label: '杯' },
      floz: { factor: 0.0295735, label: '液盎司' },
      tbsp: { factor: 0.0147868, label: '汤匙' },
      tsp: { factor: 0.00492892, label: '茶匙' },
      cm3: { factor: 0.001, label: '立方厘米' },
    },
  },
  speed: {
    label: '速度',
    baseUnit: 'mps',
    units: {
      mps: { factor: 1, label: '米/秒' },
      kmph: { factor: 1 / 3.6, label: '千米/时' },
      mph: { factor: 0.44704, label: '英里/时' },
      knot: { factor: 0.514444, label: '节' },
      fps: { factor: 0.3048, label: '英尺/秒' },
      mach: { factor: 343, label: '马赫' },
      c: { factor: 299792458, label: '光速' },
    },
  },
  time: {
    label: '时间',
    baseUnit: 's',
    units: {
      y: { factor: 31557600, label: '年' },
      mo: { factor: 2629800, label: '月(30.44天)' },
      w: { factor: 604800, label: '周' },
      d: { factor: 86400, label: '天' },
      h: { factor: 3600, label: '小时' },
      min: { factor: 60, label: '分钟' },
      s: { factor: 1, label: '秒' },
      ms: { factor: 0.001, label: '毫秒' },
      us: { factor: 1e-6, label: '微秒' },
      ns: { factor: 1e-9, label: '纳秒' },
    },
  },
  data: {
    label: '数据量',
    baseUnit: 'B',
    units: {
      bit: { factor: 0.125, label: '比特' },
      B: { factor: 1, label: '字节' },
      KB: { factor: 1024, label: 'KB' },
      MB: { factor: 1048576, label: 'MB' },
      GB: { factor: 1073741824, label: 'GB' },
      TB: { factor: 1099511627776, label: 'TB' },
      PB: { factor: 1125899906842624, label: 'PB' },
      kB: { factor: 1000, label: 'kB (十进制)' },
      mB: { factor: 1e6, label: 'MB (十进制)' },
      gB: { factor: 1e9, label: 'GB (十进制)' },
      tB: { factor: 1e12, label: 'TB (十进制)' },
    },
  },
  pressure: {
    label: '压强',
    baseUnit: 'Pa',
    units: {
      Pa: { factor: 1, label: '帕斯卡' },
      kPa: { factor: 1000, label: '千帕' },
      MPa: { factor: 1e6, label: '兆帕' },
      bar: { factor: 1e5, label: '巴' },
      atm: { factor: 101325, label: '标准大气压' },
      psi: { factor: 6894.76, label: '磅/平方英寸' },
      mmHg: { factor: 133.322, label: '毫米汞柱' },
      torr: { factor: 133.322, label: '托' },
    },
  },
  energy: {
    label: '能量',
    baseUnit: 'J',
    units: {
      J: { factor: 1, label: '焦耳' },
      kJ: { factor: 1000, label: '千焦' },
      cal: { factor: 4.184, label: '卡' },
      kcal: { factor: 4184, label: '千卡' },
      Wh: { factor: 3600, label: '瓦时' },
      kWh: { factor: 3600000, label: '千瓦时' },
      eV: { factor: 1.602e-19, label: '电子伏' },
      BTU: { factor: 1055.06, label: '英热单位' },
    },
  },
  power: {
    label: '功率',
    baseUnit: 'W',
    units: {
      W: { factor: 1, label: '瓦' },
      kW: { factor: 1000, label: '千瓦' },
      MW: { factor: 1e6, label: '兆瓦' },
      hp: { factor: 745.7, label: '马力' },
      PS: { factor: 735.499, label: '公制马力' },
    },
  },
  angle: {
    label: '角度',
    baseUnit: 'deg',
    units: {
      deg: { factor: 1, label: '度' },
      rad: { factor: 180 / Math.PI, label: '弧度' },
      grad: { factor: 0.9, label: '百分度' },
      arcmin: { factor: 1 / 60, label: '角分' },
      arcsec: { factor: 1 / 3600, label: '角秒' },
      turn: { factor: 360, label: '圈' },
    },
  },
};

export function registerConversionTools(tools: ScopedToolService): void {
  // 构建分类列表供 description
  const categoryList = Object.entries(CATEGORIES)
    .map(([key, cat]) => `${key}(${cat.label}): ${Object.keys(cat.units).join(', ')}`)
    .join('\n');

  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'math_unit_convert',
        description: `单位换算工具。支持温度特殊转换(C/F/K)和以下线性单位:\n${categoryList}`,
        parameters: {
          type: 'object',
          properties: {
            value: { type: 'number', description: '要转换的数值' },
            from: { type: 'string', description: '源单位（如 km, lb, C, F）' },
            to: { type: 'string', description: '目标单位' },
          },
          required: ['value', 'from', 'to'],
        },
      },
    },
    handler: async args => {
      try {
        const value = Number(args.value);
        const from = String(args.from);
        const to = String(args.to);

        // 温度特殊处理
        if (isTemperature(from) && isTemperature(to)) {
          const result = convertTemperature(value, from, to);
          return JSON.stringify({ value, from, to, result });
        }

        // 查找单位所属分类
        const fromCat = findCategory(from);
        const toCat = findCategory(to);

        if (!fromCat) return JSON.stringify({ error: `未知单位: ${from}` });
        if (!toCat) return JSON.stringify({ error: `未知单位: ${to}` });
        if (fromCat.key !== toCat.key) {
          return JSON.stringify({ error: `单位不兼容: ${from}(${fromCat.cat.label}) 和 ${to}(${toCat.cat.label})` });
        }

        // base = value * fromFactor, result = base / toFactor
        const base = value * fromCat.cat.units[from].factor;
        const result = base / toCat.cat.units[to].factor;

        return JSON.stringify({
          value,
          from: `${from} (${fromCat.cat.units[from].label})`,
          to: `${to} (${toCat.cat.units[to].label})`,
          result,
          category: fromCat.cat.label,
        });
      } catch (err: unknown) {
        return JSON.stringify({ error: (err as Error).message });
      }
    },
  });
}

function isTemperature(unit: string): boolean {
  return ['C', 'F', 'K'].includes(unit);
}

function convertTemperature(value: number, from: string, to: string): number {
  // 先转为 Celsius
  let celsius: number;
  switch (from) {
    case 'C':
      celsius = value;
      break;
    case 'F':
      celsius = ((value - 32) * 5) / 9;
      break;
    case 'K':
      celsius = value - 273.15;
      break;
    default:
      throw new Error(`未知温度单位: ${from}`);
  }
  // 从 Celsius 转出
  switch (to) {
    case 'C':
      return celsius;
    case 'F':
      return (celsius * 9) / 5 + 32;
    case 'K':
      return celsius + 273.15;
    default:
      throw new Error(`未知温度单位: ${to}`);
  }
}

function findCategory(unit: string): { key: string; cat: UnitCategory } | null {
  for (const [key, cat] of Object.entries(CATEGORIES)) {
    if (unit in cat.units) return { key, cat };
  }
  return null;
}
