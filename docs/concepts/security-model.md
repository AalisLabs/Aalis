# 安全模型 — 威胁模型与插件作者的责任边界

> 面向：写 / 维护 Aalis 第三方插件的人。
>
> 这篇讲「Aalis 把谁当敌人、把谁当可信，以及框架替你挡了什么、又有哪些边界要你自己守」。
> 不读它，你很容易写出一个「owner 一句话被群里陌生人注入提示词就被借权」或「LLM 拿用户给的 URL
> 把内网元数据接口打穿」的插件。安全在 Aalis 不是某一个插件的功能，而是一组贯穿全栈的不变量——
> 你的插件要么帮着维持它们，要么就是那个捅破口子的人。

相关概念：[权限两轴（authority）](../core/authority.md) · [存储不是沙箱](#存储不是沙箱storage-不confine-子进程) ·
forward-ref [services/authority](../services/authority.md)（裁决服务全量 API）。

---

## 1. 单 owner 威胁模型：谁可信、谁是敌人

Aalis 是**单 owner 的本地优先（local-first）个人 bot 框架**。整套安全设计都建立在这个前提上，
偏离它谈安全没有意义。

| 角色 | 信任级别 | 说明 |
|---|---|---|
| **owner**（你自己） | **完全可信** | 持有进程 / 配置 / 磁盘的人。owner = ∞，不在等级轴上（见下）。owner 能做的≈服务器能做的。 |
| **入站 onebot / 平台聊天用户** | **不可信** | 群里、私聊里任何对 bot 说话的人。默认等级 0，可被 owner 调高 / 封禁（负数）。 |
| **LLM 的输出 / 提示注入** | **不可信** | 模型可能被聊天内容、被抓回来的网页、被工具结果里夹带的指令操纵。**把 LLM 当成一个会被收买的内鬼**——它发起的每个工具调用都要过权限闸。 |
| **owner 会话内的注入** | **半可信** | 即便发起者是 owner 本人，会话里可能夹带了攻击者的提示词。所以「确认轴」对 owner 也生效（见 §2）。 |

**明确不在威胁模型内（deferred，别指望框架替你扛）**：

- **云端 / 多租户 / 多用户隔离**：Aalis 不是 SaaS。没有账户密码、没有跨平台账户绑定、没有能力委托树。
  多用户身份是一个被搁置的调研方向，
  当前代码按单 owner 收口。
- **对抗能在本机执行代码的攻击者**：能 spawn 进程 / 读你磁盘的人就是 owner 级别，没什么可防的。
  code-sandbox 是「OS 级减速带」不是「强隔离」（见 §4）。

> 一句话给插件作者：**你要防的是「聊天里的陌生人」和「被注入的 LLM」，不是「拿到 shell 的黑客」。**

---

## 2. 权限两轴（速览 + 链接）

权限裁决拆成两条**互相正交**的轴，纯判定逻辑在
[`packages/plugin-authority/src/authority-model.ts`](../../packages/plugin-authority/src/authority-model.ts)：

- **轴 A · 授权（谁有资格）**：把触发者**等级**和操作**最低等级**比大小。
  `resolveAccess`（authority-model.ts:76）的优先级，首个命中赢：

  ```
  deniedCapabilities（全局硬禁 glob，压过 owner）  >  owner(∞)  >  level >= minLevel
  ```

  - 身份 → 整数等级：默认 `DEFAULT_AUTHORITY = 0`（authority-model.ts:18），封禁=负数，
    owner = `OWNER_RANK = +∞`（authority-model.ts:16，靠 `owners` 列表归属，不入等级表）。
  - 操作 → 最低等级 `minLevel`，由 `resolveMinLevel`（authority-model.ts:48）按
    `authorityOverrides[cap] > risk 派生 > visibility 兜底` 解析：
    `risk` 的 `safe→0 / sensitive→1 / dangerous→2`（`riskToLevel`，authority-model.ts:23），
    `visibility` 的 `public→0 / restricted→RESTRICTED_LEVEL(2)`（authority-model.ts:20、59）。
  - `deniedCapabilities` 是**配置总闸、glob 硬禁，连 owner 都压过**（authority-model.ts:77）——
    它不是 per-user 黑名单，是「这台机器上谁都不许做」的系统级断路器，慎用。

- **轴 B · 确认（是不是你本人此刻要做）**：HITL（human-in-the-loop）意图确认，与等级无关。
  关键点：**owner 也吃确认**——这是专门为「owner 会话被提示注入借权静默调高危」设计的减速带
  （authority-model.ts:11、95-105）。
  - `confirm: 'always'` **永不可跳过**（最高危，每次都得有人点头；cron 这种无人确认的源直接拒）。
  - `confirm: 'session'` 在三种情况下可跳：系统/受信源（`skipConfirm`，如 scheduler 无人可点）、
    或 owner 本人且 auto 模式激活（`shouldSkipConfirm`，authority-model.ts:95）。

**`risk` 是一次声明给两轴设默认的糖**：`dangerous` 一次展开成
`visibility:'restricted'`（抬高轴 A 门槛）+ `confirm:'session'`（轴 B 需确认）
（见 [`plugin-authority-api/src/index.ts:51`](../../packages/plugin-authority-api/src/index.ts) 的 `RISK_DEFAULTS`）。

> 两轴的完整机制（临时放行 `requestAccess`、会话授予、auto 模式、WebUI 权限页、users.json 持久化、
> session-confirm 协调）见 [权限系统文档](../core/authority.md) 与 forward-ref
> [`docs/services/authority.md`](../services/authority.md)。这里只给安全视角的要点。

### 插件作者怎么标操作风险（provider 侧）

裁决发生在 commands / tools 的执行边界，你**不需要手动调 `authorize`**——你只要在注册操作时
把风险**声明对**，框架自动挂闸。

工具注册（同形于 [`plugin-tool-system/src/tools/http.ts:182`](../../packages/plugin-tool-system/src/tools/http.ts) 的 `http_download`）：

```typescript
tools.register({
  definition: { type: 'function', function: { name: 'my_write_tool', /* ... */ } },
  // 写操作：受限 + 每次确认。防被注入的 LLM 静默/越权地写进 storage。
  visibility: 'restricted',
  confirm: 'session',
  handler: async args => { /* ... */ },
});
```

命令注册（`plugin-user-profile/src/index.ts:2355` 用 `risk` 糖一次设两轴）：

```typescript
ctx.command('profile.self.clear', '【慎用】清空 Aalis 自档案', { risk: 'dangerous' })
// 等价于 visibility:'restricted' + confirm:'session'
// 也可显式覆盖：{ risk: 'dangerous', confirm: 'always' } —— 删库级操作每次都问
```

**判断原则**：

- 只读、不可逆性低、对谁都安全 → 不声明（默认 `public` / 等级 0 / 无确认）。
- 有副作用但可控（写文件、发消息）→ `visibility:'restricted'` 或 `risk:'sensitive'`。
- 不可逆 / 能外泄 / 能改系统（shell、删库、转账、写 `data:/users.json`）→ `risk:'dangerous'`，
  必要时 `confirm:'always'`。

漏标 risk 的代价：一个被提示注入的 LLM 会**没有任何拦截**地调用你的危险工具。这是插件作者最常见、
后果最重的安全 bug。

---

## 3. safeFetch：默认的 SSRF 安全出口

任何**由用户 / LLM / 入站消息影响到的 URL** 的远程请求，都必须走
[`@aalis/util-network-guard`](../../packages/util-network-guard/src/index.ts) 的 `safeFetch`，
**不要直接用裸 `fetch`**。

`safeFetch`（index.ts:163）= 逐跳 `redirect:'manual'` + 每跳重新 `assertSafeUrl`，挡的是 SSRF：

1. **协议白名单**：只允许 `http:` / `https:`，其余（`file:`、`gopher:`…）直接拒（index.ts:144）。
2. **私网 / 回环 / 链路本地 / 元数据段封锁**（`isPrivateAddress`，index.ts:16）：
   `10.0.0.0/8`、`127.0.0.0/8`、`0.0.0.0/8`、`169.254.0.0/16`（含 AWS / 云元数据 `169.254.169.254`）、
   `172.16–31`、`192.168`、组播/保留段，以及 IPv6 的 `::1`/`::`/`fe80:`/`fc`/`fd`/`::ffff:`映射。
   **域名也查**：`dns.lookup(all)` 解析出的每条 A/AAAA 命中私网即拒（index.ts:127-133），堵住 DNS rebinding。
   `localhost` / `*.localhost` / `*.local` 主机名直接拦（index.ts:124）。
3. **逐跳重定向重校验**（index.ts:165-171）：30x 的 `Location` 解析成绝对 URL 后**再过一遍 `assertSafeUrl`**，
   杜绝「初始 host 受信，但 302 跳到 `http://169.254.169.254/` 内网」的经典绕过。跳数上限 5（`MAX_REDIRECTS`）。
4. **进程级网络策略**（`setNetworkPolicy`，index.ts:91）：owner 经 core 的 `network` 配置可以
   关私网拦截（`blockPrivate:false`，本地自动化用）、追加 `denyCidrs`、限定 `allowedPorts`。
   启动时由 `plugin-authority` 注入一次（[`plugin-authority/src/index.ts:51`](../../packages/plugin-authority/src/index.ts)）。

消费者侧用法极简（一行替换 `fetch`），全仓已有十几处复用——onebot 附件下载、media、ASR、ollama、
office、webui 图片代理、http 工具：

```typescript
import { safeFetch } from '@aalis/util-network-guard';

// 用户/LLM 给的 url：直接当 fetch 用，SSRF 校验已内置
const res = await safeFetch(url, { signal: AbortSignal.timeout(15_000) });
```

> 还需要校验单个主机名（非 fetch 场景，如流式代理自己管连接）用 `assertSafeHost(hostname)`；
> 只校验 URL 拿回 `URL` 对象用 `assertSafeUrl(rawUrl)`。

### ⚠️ 跨域重定向凭证泄漏（审计点）

`safeFetch` 的每一跳都把**同一个 `init` 原样重发**（index.ts:166：`fetch(current.href, { ...init, redirect:'manual' })`）。
这意味着：如果你在 `init.headers` 里带了 `Authorization` / cookie 等凭证，而上游返回 302 跳到**另一个 origin**，
**你的凭证会被原样发到那个新 origin**。`safeFetch` 只保证「跳到的地方不是内网」，**不保证「跳到的地方该不该看到你的 token」**。

插件作者的对策（见 [`webui-server/src/routes/proxy.ts:33`](../../packages/plugin-webui-server/src/routes/proxy.ts) 的图片代理范例）：

- 对**用户 / LLM 影响的 URL** 调 `safeFetch` 时**不要带任何凭证 / cookie / 用户 referer**——
  图片代理就显式只给一个伪 UA、不带 cookie。
- 真要带凭证访问你**自己已知的固定 API**，那个 URL 不该来自用户输入；或自行禁用重定向 / 比对最终 origin。

---

## 4. code-sandbox-os：OS 级边界，不是强隔离

`code_runner` 跑「不可信代码」（LLM 生成的脚本）时，经
[`@aalis/plugin-code-sandbox-os`](../../packages/plugin-code-sandbox-os/src/index.ts) 把子进程包进
OS 原生沙箱：Linux `bubblewrap`（bwrap）、macOS `sandbox-exec`（Seatbelt）。

它**强制**（`sandbox.ts`）：

- **写限定**：只放行 `policy.fsWrite` 白名单目录（工作区 + 本次临时目录），其余只读
  （Seatbelt `deny default` + `allow file-write*` 仅白名单，sandbox.ts:42；bwrap `--ro-bind / /` + `--bind` 白名单，sandbox.ts:84）。
- **网络粗粒度开关**：`policy.network` `'deny'` 默认断网（Seatbelt `(deny network*)`、bwrap `--unshare-all` 含 net 命名空间隔离），`'allow'` 才放开——**无法按域名过滤**（sandbox.ts:43、83）。
- **env 清零仅留白名单**：`sandbox-exec ... env -i <白名单>` / bwrap `--clearenv --setenv`，防宿主 secrets 泄漏给不可信代码（sandbox.ts:7、56、80）。

它**不防**（[`code-sandbox-api/src/index.ts:18-19`](../../packages/plugin-code-sandbox-api/src/index.ts) 明写的 v1 语义）：

- **读取本机其它文件**——v1 读放开（解释器需要系统库）。要防读需要更强的 WASM / microVM 实现。
- 内核漏洞 / 提权 / sandbox 逃逸——这是 OS 减速带，不是 gVisor / 虚拟机级别的强隔离。

**fail-closed 是不变量**：要求隔离（`policy` 非空）但本机无可用后端时，
`code_runner` **拒绝执行**而不是静默裸跑（[`runner.ts:78-89`](../../packages/plugin-tool-code-runner/src/runner.ts)）；
后端可用性靠**功能性试跑**探测（真跑一次最小沙箱命令，覆盖「命令存在」+「Linux unprivileged userns 真能用」，
[`code-sandbox-os/src/index.ts:26`](../../packages/plugin-code-sandbox-os/src/index.ts)）。

> 如果你的插件要执行不可信代码，**用 `useCodeSandbox(ctx)` 取服务、`available` 为假就 fail-closed**，
> 不要自己 `child_process.spawn` 裸跑（参见 [`code-runner` 文档](../plugins/plugin-tool-code-runner.md)、
> [`code-sandbox-os` 文档](../plugins/plugin-code-sandbox-os.md)）。

---

## 5. 存储不是沙箱（storage 不 confine 子进程）

[`StorageService`](../../packages/plugin-storage-api/src/index.ts) 把读写收口到声明的 root（`<root>:/path`），
做了根内 `..` 穿越保护和 symlink realpath 校验——但那是**防上层代码 bug**，**不是用来对抗恶意子进程的**
（storage-api index.ts:79-85 明写）。

关键陷阱：`resolveLocalPath(uri)`（storage-api index.ts:96-102）把 storage URI 解析成一个 **OS 绝对路径**
交给 shell / `run_python` 等子进程。一旦子进程拿到这条路径，**它能访问当前 OS 用户能访问的任何文件**——
storage 那层校验对子进程毫无约束力。真正的隔离要靠 §4 的 OS 沙箱或 OS 用户权限。

> 给插件作者：把 `resolveLocalPath` 的结果当「工作目录起点」用，别当「沙箱边界」。
> storage URI 文法、保留 scheme（`http`/`https`/`file` 不是 storage URI）见 forward-ref
> [`docs/concepts/storage-uri-grammar.md`](./storage-uri-grammar.md) 与 [`docs/services/storage.md`](../services/storage.md)。

---

## 6. readExternalFile：confused-deputy 读任意路径

[`ProcessService.readExternalFile(path)`](../../packages/plugin-process-api/src/index.ts)（契约 index.ts:91-100，
本地实现 [`process-local/src/index.ts:123`](../../packages/plugin-process-local/src/index.ts)）= **直读 OS 任意本地路径**
（绝对路径或 `file://`），**完全绕过 storage 的 root 沙箱**。它就是 `fs.readFile` 加了个 `file://` 剥壳。

存在的理由：拿到「外部推来的本地路径」的合法场景——OneBot daemon 推送的附件路径、ASR/ollama 探测本地文件等
（消费者见 `plugin-adapter-onebot/src/attachment-cache.ts:117`、`plugin-asr-openai/src/index.ts:59`、
`plugin-media/src/llm-adapter.ts:199`）。

**这是一个 confused-deputy（混淆代理）面**：daemon 进程是受信的，但「要读哪个 path」这个参数可能源自不可信输入。
如果路径来自聊天用户 / LLM，攻击者可以诱导你读 `/etc/passwd`、`~/.ssh/id_rsa`、`data:/users.json` 等。
契约注释（index.ts:97）写得很直白：**「调用方自行保证安全性」**——框架在这里不替你挡。

插件作者的对策：

- **绝不**把用户 / LLM 给的字符串原样喂给 `readExternalFile`。
- 只在「路径由你信任的 daemon/协议带来」时用它（如 onebot 上报里的 `file` 字段）。
- 用户给的内容路径，优先走 storage（受 root 约束）；要读外部就先白名单校验目录前缀。

---

## 7. 给插件作者的安全清单（TL;DR）

1. **任何用户/LLM 影响的 URL → `safeFetch`**，绝不裸 `fetch`；带凭证时警惕跨域重定向（§3）。
2. **危险操作标对 risk**：不可逆/外泄/改系统 → `risk:'dangerous'` 或 `visibility:'restricted'+confirm`；
   删库级 → `confirm:'always'`（§2）。漏标 = 被注入的 LLM 直通。
3. **执行不可信代码 → 取 code-sandbox 服务，`available` 为假就 fail-closed**，别裸跑（§4）。
4. **`resolveLocalPath` 不是沙箱边界**，只当工作目录起点（§5）。
5. **`readExternalFile` 只喂可信来源的路径**，永不喂用户/LLM 字符串（§6）。
6. 记住威胁模型：敌人是聊天里的陌生人 + 被注入的 LLM，不是拿到 shell 的人（§1）。

---

## 交叉链接

- 兄弟概念：[权限两轴 / authority](../core/authority.md) · forward-ref [storage URI 文法](./storage-uri-grammar.md) ·
  forward-ref [DI 服务模型](./service-model.md)
- forward-ref 服务文档：[`services/authority`](../services/authority.md)（裁决服务全量 API）·
  [`services/storage`](../services/storage.md) · [`services/process`](../services/process.md)
- 相关插件文档：[`plugin-tool-code-runner`](../plugins/plugin-tool-code-runner.md) ·
  [`plugin-code-sandbox-os`](../plugins/plugin-code-sandbox-os.md) · [`plugin-authority`](../plugins/plugin-authority.md)
- 多用户/云端：搁置（未实现）
