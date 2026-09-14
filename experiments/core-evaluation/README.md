# Aalis Core / Cordis 可复查评估

本目录保存 2026-09-15 的评估探针与结果。结论见 [评估报告](ASSESSMENT.zh-CN.md)。只新增实验材料，没有修改生产 Core、既有测试、依赖或锁文件。

**测试变绿表示当前行为被成功复现，不表示所有目标契约已经满足。** 部分探针刻意断言当前缺口，避免把不同设计语义误当成测试框架失败。请同时读取结果中的 `contractPassed`、`goalSatisfied` 和 `interpretation`。修复 Core 后，需要把对应探针改为断言目标行为，再移入正常回归测试；不要为了保持这份历史评估变绿而保留缺陷。

| 材料 | 用途 |
| --- | --- |
| `aalis-lifecycle.test.ts` | 提供者变化、初始化与卸载、重入和依赖重算竞争 |
| `composition-contracts.test.ts` | 多提供者关停、动态模块异步清理、重复上下文 id |
| `cordis-comparison.test.ts` | 在两个真实实现上对照服务、作用域、事件与资源归属 |
| `portability.mjs` / `portability-fixture.ts` | 新编译产物、外部类型消费、真实浏览器与 Worker |
| `results/` | 本次观察记录；重新运行探针会更新对应结果 |

**比较版本**：Aalis Core `0.12.1`；本地提交 `c6ceff2ed9e89f6d5fe655b2fca6229e5b3ad1b6`，Core 源文件哈希在 `results/baseline.json`。DSH 固定到 `c291e7961a515f6d7af9304e7fd1d257929aef26`，使用其中 `vendor/cordis` 的 `@deepseek-ai/cordis 4.0.2`，并非未修改的上游 Cordis，也没有运行整个 DSH 产品。

以下命令从 Aalis 仓库根目录执行，使用仓库现有 pnpm、Vitest、TypeScript 和 tsx/esbuild，不向仓库安装比较对象。DSH 路径需指向下列固定提交的干净源码；本次实际使用的是 `/tmp/dsh-core-review.iDxwo6/deepseek-harness`。

```sh
# 若还没有比较源码，选一个新的临时目录。
export DSH_SOURCE_DIR=/tmp/aalis-cordis-evaluation
git init "$DSH_SOURCE_DIR"
git -C "$DSH_SOURCE_DIR" remote add origin https://github.com/deepseek-ai/deepseek-harness.git
git -C "$DSH_SOURCE_DIR" fetch --depth=1 origin c291e7961a515f6d7af9304e7fd1d257929aef26
git -C "$DSH_SOURCE_DIR" checkout --detach FETCH_HEAD

# 既有 Core 回归与仅针对 Core 源码的覆盖率。
pnpm exec vitest run test/core --coverage --coverage.include='packages/core/src/**/*.ts' --coverage.reportsDirectory=/tmp/aalis-core-coverage --coverage.reporter=text-summary --coverage.reporter=json-summary

# 对抗与对照探针。配置会把 Cordis/cosmokit 指向固定源码，不执行其安装脚本。
pnpm exec vitest run --config experiments/core-evaluation/vitest.config.ts

# 新编译 Core 到临时目录；不覆盖仓库 dist。
node experiments/core-evaluation/portability.mjs
```

只跑 Aalis 探针不需要 DSH 源码：

```sh
pnpm exec vitest run --config experiments/core-evaluation/vitest.config.ts experiments/core-evaluation/aalis-lifecycle.test.ts experiments/core-evaluation/composition-contracts.test.ts
```

可移植性脚本寻找本机 Chrome；也可通过 `CHROME_PATH` 指定。没有 Chrome 时必须将真实浏览器/Worker 结果视为未验证，打包成功不能代替执行成功。`DSH_SOURCE_DIR` 控制 Cordis 的浏览器对照，`KEEP_PORTABILITY_TMP=1` 可保留临时消费者供检查。

可移植性脚本会汇总 `smokeSummary`：新产物编译、类型消费、Node ESM/CJS 消费、浏览器打包，以及已启动浏览器中的主线程、Worker 和正常关闭任一失败，退出码为 `1`。无 Chrome 时明确记录跳过，可以退出 `0`。工作区旧 `dist`（干净检出可能不存在）、内部深导入和错误提供者类型反例只记录观察，不参与成功判定；修复这些边界不会让烟测失败。无需重跑编译器或浏览器即可复查记录的退出判定：`node experiments/core-evaluation/portability.mjs --check-results experiments/core-evaluation/results/portability.json`；此命令不覆盖记录。

本次记录环境为 Node `22.16.0`、pnpm `10.32.1`、Vitest `2.1.9`、TypeScript `5.9.3`、esbuild `0.27.4`、macOS arm64、Chrome `152.0.7977.83`。这只说明所测内核代码在这些环境中的行为，不代表整个 DSH 支持该 Node 版本。未运行性能基准、长期内存压力、多进程故障恢复或整个应用测试，不能据此排名吞吐、内存、可靠性或生态成熟度。
