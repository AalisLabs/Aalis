import type { Context } from '@aalis/core';

export function registerGeometryTools(ctx: Context): void {
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'math_geometry',
        description: '几何计算工具。支持: distance(两点距离)、midpoint(中点)、triangle_area(三角形面积)、circle(圆的面积/周长)、rectangle(矩形面积/周长)、sphere(球体积/表面积)、cylinder(圆柱体积/表面积)、cone(圆锥体积/表面积)、polygon_area(多边形面积-Shoelace公式)、angle_between_vectors(向量夹角)、line_intersection(两直线交点)、point_to_line_distance(点到直线距离)',
        parameters: {
          type: 'object',
          properties: {
            operation: { type: 'string', description: '操作类型' },
            // 点/向量
            point1: { type: 'array', items: { type: 'number' }, description: '点1坐标 [x,y] 或 [x,y,z]' },
            point2: { type: 'array', items: { type: 'number' }, description: '点2坐标' },
            point3: { type: 'array', items: { type: 'number' }, description: '点3坐标（三角形第3个顶点）' },
            points: { type: 'array', description: '多边形顶点列表 [[x,y], ...]' },
            // 形状参数
            radius: { type: 'number', description: '半径' },
            width: { type: 'number', description: '宽度' },
            height: { type: 'number', description: '高度' },
            slantHeight: { type: 'number', description: '圆锥斜高' },
            // 向量
            vector1: { type: 'array', items: { type: 'number' }, description: '向量1' },
            vector2: { type: 'array', items: { type: 'number' }, description: '向量2' },
            // 直线 (ax + by + c = 0)
            line1: { type: 'array', items: { type: 'number' }, description: '直线1系数 [a, b, c]' },
            line2: { type: 'array', items: { type: 'number' }, description: '直线2系数 [a, b, c]' },
            point: { type: 'array', items: { type: 'number' }, description: '点坐标 [x, y]' },
            line: { type: 'array', items: { type: 'number' }, description: '直线系数 [a, b, c]' },
            // 三边长
            a: { type: 'number', description: '边长a' },
            b: { type: 'number', description: '边长b' },
            c: { type: 'number', description: '边长c' },
          },
          required: ['operation'],
        },
      },
    },
    handler: async (args) => {
      try {
        const op = String(args.operation);

        switch (op) {
          case 'distance': {
            const p1 = args.point1 as number[];
            const p2 = args.point2 as number[];
            if (!p1 || !p2 || p1.length !== p2.length) {
              return JSON.stringify({ error: '需要维度相同的 point1 和 point2' });
            }
            const d = Math.sqrt(p1.reduce((s, v, i) => s + (v - p2[i]) ** 2, 0));
            return JSON.stringify({ distance: d });
          }

          case 'midpoint': {
            const p1 = args.point1 as number[];
            const p2 = args.point2 as number[];
            if (!p1 || !p2 || p1.length !== p2.length) {
              return JSON.stringify({ error: '需要维度相同的 point1 和 point2' });
            }
            return JSON.stringify({ midpoint: p1.map((v, i) => (v + p2[i]) / 2) });
          }

          case 'triangle_area': {
            // 方式1: 三个顶点坐标
            const p1 = args.point1 as number[] | undefined;
            const p2 = args.point2 as number[] | undefined;
            const p3 = args.point3 as number[] | undefined;
            if (p1 && p2 && p3) {
              if (p1.length === 2) {
                // 2D Shoelace
                const area = Math.abs((p1[0] * (p2[1] - p3[1]) + p2[0] * (p3[1] - p1[1]) + p3[0] * (p1[1] - p2[1])) / 2);
                return JSON.stringify({ area });
              }
              // 3D cross product
              const u = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]];
              const v = [p3[0] - p1[0], p3[1] - p1[1], p3[2] - p1[2]];
              const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
              const area = Math.sqrt(cross[0] ** 2 + cross[1] ** 2 + cross[2] ** 2) / 2;
              return JSON.stringify({ area });
            }
            // 方式2: 三边长 (海伦公式)
            const a = Number(args.a ?? 0), b = Number(args.b ?? 0), c = Number(args.c ?? 0);
            if (a > 0 && b > 0 && c > 0) {
              const s = (a + b + c) / 2;
              const area = Math.sqrt(s * (s - a) * (s - b) * (s - c));
              return JSON.stringify({ area, semiPerimeter: s });
            }
            return JSON.stringify({ error: '需要 (point1, point2, point3) 或 (a, b, c) 三边长' });
          }

          case 'circle': {
            const r = Number(args.radius ?? 0);
            if (r <= 0) return JSON.stringify({ error: '半径必须为正数' });
            return JSON.stringify({
              radius: r,
              area: Math.PI * r * r,
              circumference: 2 * Math.PI * r,
              diameter: 2 * r,
            });
          }

          case 'rectangle': {
            const w = Number(args.width ?? 0), h = Number(args.height ?? 0);
            if (w <= 0 || h <= 0) return JSON.stringify({ error: '宽度和高度必须为正数' });
            return JSON.stringify({
              area: w * h,
              perimeter: 2 * (w + h),
              diagonal: Math.sqrt(w * w + h * h),
            });
          }

          case 'sphere': {
            const r = Number(args.radius ?? 0);
            if (r <= 0) return JSON.stringify({ error: '半径必须为正数' });
            return JSON.stringify({
              volume: (4 / 3) * Math.PI * r ** 3,
              surfaceArea: 4 * Math.PI * r * r,
            });
          }

          case 'cylinder': {
            const r = Number(args.radius ?? 0), h = Number(args.height ?? 0);
            if (r <= 0 || h <= 0) return JSON.stringify({ error: '半径和高度必须为正数' });
            return JSON.stringify({
              volume: Math.PI * r * r * h,
              lateralArea: 2 * Math.PI * r * h,
              totalSurfaceArea: 2 * Math.PI * r * (r + h),
            });
          }

          case 'cone': {
            const r = Number(args.radius ?? 0), h = Number(args.height ?? 0);
            if (r <= 0 || h <= 0) return JSON.stringify({ error: '半径和高度必须为正数' });
            const slant = Number(args.slantHeight) || Math.sqrt(r * r + h * h);
            return JSON.stringify({
              volume: (1 / 3) * Math.PI * r * r * h,
              slantHeight: slant,
              lateralArea: Math.PI * r * slant,
              totalSurfaceArea: Math.PI * r * (r + slant),
            });
          }

          case 'polygon_area': {
            const pts = args.points as number[][];
            if (!pts || pts.length < 3) return JSON.stringify({ error: '至少需要 3 个顶点' });
            // Shoelace 公式
            let area = 0;
            const n = pts.length;
            for (let i = 0; i < n; i++) {
              const j = (i + 1) % n;
              area += pts[i][0] * pts[j][1];
              area -= pts[j][0] * pts[i][1];
            }
            area = Math.abs(area) / 2;
            // 周长
            let perimeter = 0;
            for (let i = 0; i < n; i++) {
              const j = (i + 1) % n;
              perimeter += Math.sqrt((pts[j][0] - pts[i][0]) ** 2 + (pts[j][1] - pts[i][1]) ** 2);
            }
            return JSON.stringify({ area, perimeter, vertices: n });
          }

          case 'angle_between_vectors': {
            const v1 = args.vector1 as number[];
            const v2 = args.vector2 as number[];
            if (!v1 || !v2 || v1.length !== v2.length) {
              return JSON.stringify({ error: '需要维度相同的 vector1 和 vector2' });
            }
            const dot = v1.reduce((s, a, i) => s + a * v2[i], 0);
            const m1 = Math.sqrt(v1.reduce((s, x) => s + x * x, 0));
            const m2 = Math.sqrt(v2.reduce((s, x) => s + x * x, 0));
            if (m1 === 0 || m2 === 0) return JSON.stringify({ error: '向量模不能为零' });
            const cosA = Math.max(-1, Math.min(1, dot / (m1 * m2)));
            const radians = Math.acos(cosA);
            return JSON.stringify({
              radians,
              degrees: radians * 180 / Math.PI,
              cosine: cosA,
            });
          }

          case 'line_intersection': {
            const l1 = args.line1 as number[];
            const l2 = args.line2 as number[];
            if (!l1 || !l2 || l1.length !== 3 || l2.length !== 3) {
              return JSON.stringify({ error: '需要 line1=[a,b,c] 和 line2=[a,b,c]，表示 ax+by+c=0' });
            }
            const det = l1[0] * l2[1] - l2[0] * l1[1];
            if (Math.abs(det) < 1e-12) return JSON.stringify({ error: '两直线平行或重合' });
            const x = (l1[1] * l2[2] - l2[1] * l1[2]) / det;
            const y = (l2[0] * l1[2] - l1[0] * l2[2]) / det;
            return JSON.stringify({ intersection: [x, y] });
          }

          case 'point_to_line_distance': {
            const pt = args.point as number[];
            const ln = args.line as number[];
            if (!pt || !ln || pt.length < 2 || ln.length !== 3) {
              return JSON.stringify({ error: '需要 point=[x,y] 和 line=[a,b,c]' });
            }
            const dist = Math.abs(ln[0] * pt[0] + ln[1] * pt[1] + ln[2]) / Math.sqrt(ln[0] ** 2 + ln[1] ** 2);
            return JSON.stringify({ distance: dist });
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
