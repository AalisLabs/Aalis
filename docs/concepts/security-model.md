# 安全模型 — 威胁模型与插件作者的责任边界

> 面向：编写和维护 Aalis 第三方插件的人。
>
> 这篇讲清楚 Aalis 把谁当敌人、把谁当可信，以及框架替你挡住了什么、又有哪些边界需要你自己守。
> 不了解这些，你很容易写出这样的插件：owner 被群里的陌生人注入一句提示词就被借走权限，或者
> LLM 拿着用户给的 URL 把内网元数据接口打穿。安全在 Aalis 不是某一个插件的功能，而是一组贯穿
> 全栈的不变量——你的插件要么帮助维持这些不变量，要么就会成为破坏它们的那一环。

相关概念：[权限两轴（authority）](../core/authority.md) · [存储不是沙箱](#存储不是沙箱storage-不confine-子进程) ·
forward-ref [services/authority](../services/authority.md)（裁决服务全量 API）。

---

## 1. 单 owner 威胁模型：谁可信、谁是敌人

Aalis 是**单 owner 的本地优先（local-first）个人 bot 框架**。整套安全设计都建立在这个前提之上，
偏离它谈安全没有意义。

| 角色 | 信任级别 | 说明 |
|---|---|---|
| **owner**（你自己） | **完全可信** | 持有进程 / 配置 / 磁盘的人。owner = ∞，不在等级轴上（见下）。owner 能做的约等于服务器本身能做的。 |
| **入站 onebot / 平台聊天用户** | **不可信** | 群聊、私聊中任何对 bot 说话的人。默认等级 0，可被 owner 调高或封禁（负数）。 |
| **LLM 的输出 / 提示注入** | **不可信** | 模型可能被聊天内容、被抓取回来的网页、被工具结果里夹带的指令操纵。应把 LLM 视为可能被策反的内部角色——它发起的每个工具调用都必须经过权限闸。 |
| **owner 会话内的注入** | **半可信** | 即便发起者是 owner 本人，会话里也可能夹带了攻击者的提示词。因此「确认轴」对 owner 同样生效（见 §2）。 |

**以下内容明确不在威胁模型之内（deferred，框架不提供这方面的防护）**：

- **云端 / 多租户 / 多用户隔离**：Aalis 不是 SaaS。没有账户密码、没有跨平台账户绑定、没有能力委托树。
  多用户身份是一个被搁置的调研方向，当前代码按单 owner 收口。
- **对抗能在本机执行代码的攻击者**：能 spawn 进程、能读你磁盘的人已经是 owner 级别，在威胁模型内无从防御。
  code-sandbox 提供的是 OS 级边界，而不是强隔离（见 §4）。
- **对抗已装插件**：插件与内核同进程、同权限。它可以用高 `priority` 覆盖 `authority` / `llm` /
  `storage` 等既有服务（[服务模型](./service-model.md)的选择规则如此设计），下游惰性
  `getService` 会立即改路由；也可以直接 monkey-patch 任何护栏。**这是特性不是漏洞** ——
  「万物皆插件」的前提就是任何实现可被替换，而装插件是 owner 级操作。
  框架里各种「护栏」（禁卸内核、降级守卫、串行闸）防的都是**误操作**，不是恶意插件。
  真正的防线在装之前：市场的依赖图端点会列出目标提供 / 需要哪些服务，装前可见。

因此，你的插件真正要防的是聊天中的陌生人和被注入的 LLM，而不是已经取得 shell 的攻击者。

---

## 2. 权限两轴（速览 + 链接）

权限裁决拆成两条**互相正交**的轴：

- **轴 A · 授权（谁有资格）**：把触发者的**等级**和操作的**最低等级**比大小。
  `resolveAccess` 的优先级如下，首个命中者胜出：

  ```
  deniedCapabilities（全局硬禁 glob，压过 owner）  >  owner(∞)  >  level >= minLevel
  ```

  - 身份映射到整数等级：默认 `DEFAULT_AUTHORITY = 0`，封禁为负数，
    owner = `OWNER_RANK = +∞`（靠 `owners` 列表归属，不进入等级表）。
  - 操作映射到最低等级 `minLevel`，由 `resolveMinLevel` 按
    `authorityOverrides[cap] > risk 派生 > visibility 兜底` 的顺序解析：
    `risk` 的 `safe→0 / sensitive→1 / dangerous→2`（`capabilityMinLevel`），
    `visibility` 的 `public→0 / restricted→RESTRICTED_LEVEL(2)`。
  - `deniedCapabilities` 是**配置总闸、glob 硬禁，连 owner 都压过**。
    它不是 per-user 黑名单，而是「这台机器上谁都不许做」的系统级断路器，应谨慎使用。

- **轴 B · 确认（是不是你本人此刻要做）**：HITL（human-in-the-loop）意图确认，与等级无关。
  关键点是 **owner 也受确认约束**——这道关卡专门为「owner 会话被提示注入借权、静默调用高危操作」的场景设计。
  - `confirm: 'always'` **永不可跳过**（最高危，每次都需要人工确认；cron 这类无人确认的来源直接拒绝）。
  - `confirm: 'session'` 可在三种情况下跳过：来自系统或受信源时（`skipConfirm`，例如 scheduler 无人可确认），
    或触发者是 owner 本人且 auto 模式已激活时（`shouldSkipConfirm`）。

**`risk` 是一个便捷声明，一次为两轴设定默认值**：`dangerous` 会展开成
`visibility:'restricted'`（抬高轴 A 门槛）加上 `confirm:'session'`（轴 B 需确认），
这套默认值由 `RISK_DEFAULTS` 定义。

> 两轴的完整机制（临时放行 `requestAccess`、会话授予、auto 模式、WebUI 权限页、users.json 持久化、
> session-confirm 协调）见 [权限系统文档](../core/authority.md) 与 forward-ref
> [`docs/services/authority.md`](../services/authority.md)。这里只给出安全视角的要点。

### 插件作者怎么标操作风险（provider 侧）

裁决发生在 commands / tools 的执行边界。你**不需要手动调用 `authorize`**——只要在注册操作时
把风险**声明正确**，框架就会自动挂上权限闸。

工具注册（与内置 `http_download` 工具的写法一致）：

```typescript
tools.register({
  definition: { type: 'function', function: { name: 'my_write_tool', /* ... */ } },
  // 写操作：受限 + 每次确认。防止被注入的 LLM 静默、越权地写进 storage。
  visibility: 'restricted',
  confirm: 'session',
  handler: async args => { /* ... */ },
});
```

命令注册（用 `risk` 糖一次为两轴设默认）：

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

漏标 risk 的代价是：一个被提示注入的 LLM 会**没有任何拦截**地调用你的危险工具。这是插件作者
最常见、后果最重的安全 bug。

### 官方插件里刻意未声明的那些（2026-08 拍板，勿当缺陷再报）

`plugin-tool-onebot`（34 个工具，含 `onebot_delete_friend` / `onebot_delete_msg` /
`onebot_approve_join_request`）、`plugin-office`、`plugin-maimai` 三个包**全部工具未声明
risk 与 visibility**，因而解析为 `public` / 等级 0。

这是**明确的取舍，不是遗漏**：这些工具的动作面都限于机器人自己的社交账号（加删好友、撤自己
发的消息、审群申请），而部署形态是单 owner；给它们逐个上 `confirm` 会让每一次群操作都弹一次
确认，代价压过收益。**改变部署形态（多用户、开放群、把 bot 交给他人代管）时必须重新评估这一条。**

与之相对，`plugin-scheduler` 的建/删/暂停任务是**上了 `dangerous + confirm` 的**——因为建一条
cron 等于让 LLM 获得持久执行面，那已经越过"只影响自己账号"的边界。

---

## 3. safeFetch：默认的 SSRF 安全出口

任何**由用户 / LLM / 入站消息影响到的 URL** 的远程请求，都必须走
[`@aalis/util-network-guard`](../utils/network-guard.md) 的 `safeFetch`，
**不要直接使用裸 `fetch`**。

`safeFetch` 的机制是逐跳 `redirect:'manual'` 加上每一跳都重新执行 `assertSafeUrl`，
用于防御 SSRF：

1. **协议白名单**：只允许 `http:` / `https:`，其余（`file:`、`gopher:` 等）直接拒绝。
2. **私网 / 回环 / 链路本地 / 元数据段封锁**（`isPrivateAddress`）：
   覆盖 `10.0.0.0/8`、`127.0.0.0/8`、`0.0.0.0/8`、`169.254.0.0/16`（含 AWS / 云元数据 `169.254.169.254`）、
   `172.16–31`、`192.168`、组播 / 保留段，以及 IPv6 的 `::1`、`::`、`fe80:`、`fc`、`fd`、`::ffff:` 映射。
   域名同样会被检查：`dns.lookup(all)` 解析出的每条 A/AAAA 记录只要命中私网即拒，
   以此堵住 DNS rebinding。`localhost`、`*.localhost`、`*.local` 主机名会被直接拦截。
3. **逐跳重定向重校验**：30x 响应的 `Location` 解析成绝对 URL 后**再过一遍 `assertSafeUrl`**，
   杜绝「初始 host 受信，但 302 跳到 `http://169.254.169.254/` 内网」这类经典绕过。跳数上限为 5（`MAX_REDIRECTS`）。
4. **进程级网络策略**（`setNetworkPolicy`）：owner 经 core 的 `network` 配置可以
   关闭私网拦截（`blockPrivate:false`，用于本地自动化）、追加 `denyCidrs`、限定 `allowedPorts`。
   这项策略在启动时由 `plugin-authority` 注入一次。

消费者侧用法很简单（一行替换 `fetch`），全仓已有十几处复用——onebot 附件下载、media、ASR、ollama、
office、webui 图片代理、http 工具：

```typescript
import { safeFetch } from '@aalis/util-network-guard';

// 用户/LLM 给的 url：直接当 fetch 用，SSRF 校验已内置
const res = await safeFetch(url, { signal: AbortSignal.timeout(15_000) });
```

> 若你还需要校验单个主机名（非 fetch 场景，例如流式代理自己管理连接），用 `assertSafeHost(hostname)`；
> 只想校验 URL 并拿回 `URL` 对象，用 `assertSafeUrl(rawUrl)`。

### 跨域重定向的凭证泄漏

`safeFetch` 的每一跳都会把**同一个 `init` 原样重发**。这意味着：如果你在 `init.headers` 里带了
`Authorization` 或 cookie 等凭证，而上游返回 302 跳转到**另一个 origin**，
**你的凭证会被原样发送到那个新 origin**。`safeFetch` 只保证跳转目标不是内网地址，
并不保证跳转目标有资格看到你的 token。

插件作者的对策（可参考图片代理的做法）：

- 对**用户 / LLM 影响的 URL** 调用 `safeFetch` 时**不要带任何凭证 / cookie / 用户 referer**——
  图片代理就显式只给一个伪 UA、不带 cookie。
- 若确实要带凭证访问你**自己已知的固定 API**，那个 URL 就不应来自用户输入；
  或者自行禁用重定向、比对最终 origin。

---

## 4. code-sandbox-os：OS 级边界，不是强隔离

`code_runner` 执行不可信代码（LLM 生成的脚本）时，会经 `@aalis/plugin-code-sandbox-os`
把子进程包进 OS 原生沙箱：Linux 上是 `bubblewrap`（bwrap），macOS 上是 `sandbox-exec`（Seatbelt）。

它**强制**以下约束：

- **写限定**：只放行 `policy.fsWrite` 白名单目录（工作区加上本次临时目录），其余目录只读。
  实现上，Seatbelt 用 `deny default` 加 `allow file-write*` 仅对白名单放行；
  bwrap 用 `--ro-bind / /` 加 `--bind` 白名单。
- **网络粗粒度开关**：`policy.network` 为 `'deny'` 时默认断网（Seatbelt 用 `(deny network*)`，
  bwrap 用 `--unshare-all`，含 net 命名空间隔离），为 `'allow'` 时才放开——**无法按域名过滤**。
- **env 清零仅留白名单**：`sandbox-exec ... env -i <白名单>` 或 bwrap 的 `--clearenv --setenv`，
  防止宿主 secrets 泄漏给不可信代码。

它**不防**以下情形（`@aalis/api-code-sandbox` 契约写明的 v1 语义）：

- **读取本机其它文件**——v1 对读放开（解释器需要系统库）。要防读需要更强的 WASM / microVM 实现。
- 内核漏洞 / 提权 / sandbox 逃逸——这是 OS 级边界，不是 gVisor / 虚拟机级别的强隔离。

**fail-closed 是不变量**：当操作要求隔离（`policy` 非空）但本机没有可用后端时，
`code_runner` 会**拒绝执行**，而不是静默地裸跑。后端可用性靠**功能性试跑**探测——
真正跑一次最小沙箱命令，同时覆盖「命令存在」和「Linux unprivileged userns 真能用」两点。

> 如果你的插件要执行不可信代码，请用 `useCodeSandbox(ctx)` 取服务，`available` 为假时就 fail-closed，
> 不要自己 `child_process.spawn` 裸跑（参见 [`code-runner` 文档](../plugins/plugin-tool-code-runner.md)、
> [`code-sandbox-os` 文档](../plugins/plugin-code-sandbox-os.md)）。

---

## 5. 存储不是沙箱（storage 不 confine 子进程）

`StorageService` 把读写收口到声明的 root（`<root>:/path`），并做了根内 `..` 穿越保护和
symlink realpath 校验。但这层校验的目的是**防止上层代码出 bug**，**不是用来对抗恶意子进程的**——
契约中对此有明确说明。

需要注意的关键陷阱：`resolveLocalPath(uri)` 会把 storage URI 解析成一个 **OS 绝对路径**，
再交给 shell、`run_python` 等子进程。一旦子进程拿到这条路径，
**它就能访问当前 OS 用户能访问的任何文件**——storage 那层校验对子进程毫无约束力。
真正的隔离要靠 §4 的 OS 沙箱或 OS 用户权限。

> 请把 `resolveLocalPath` 的结果当作「工作目录起点」使用，而不是「沙箱边界」。
> storage URI 文法、保留 scheme（`http` / `https` / `file` 不是 storage URI）见 forward-ref
> [`docs/concepts/storage-uri-grammar.md`](./storage-uri-grammar.md) 与 [`docs/services/storage.md`](../services/storage.md)。

---

## 6. readExternalFile：confused-deputy 读任意路径

`ProcessService.readExternalFile(path)` 会**直接读取 OS 上的任意本地路径**（绝对路径或 `file://`），
**完全绕过 storage 的 root 沙箱**。它本质上就是 `fs.readFile` 再加一层 `file://` 剥壳。

它存在的理由是确实有合法场景需要读取「外部推来的本地路径」，例如 OneBot daemon 推送的附件路径、
ASR / ollama 探测本地文件等。现有消费者包括 onebot 适配器、asr-openai、media 等插件。

**这是一个 confused-deputy（混淆代理）面**：daemon 进程是受信的，但「要读哪个 path」这个参数
可能源自不可信输入。如果路径来自聊天用户或 LLM，攻击者就可以诱导你读取 `/etc/passwd`、
`~/.ssh/id_rsa`、`data:/users.json` 等文件。契约注释对此写得很直白：**「调用方自行保证安全性」**——
框架在这里不替你挡。

插件作者的对策：

- **绝不**把用户 / LLM 给的字符串原样传给 `readExternalFile`。
- 只在「路径由你信任的 daemon / 协议带来」时使用它（例如 onebot 上报里的 `file` 字段）。
- 用户给的内容路径，优先走 storage（受 root 约束）；确需读取外部文件时，先做白名单校验目录前缀。

---

## 7. 给插件作者的安全清单

1. **任何用户 / LLM 影响的 URL → `safeFetch`**，绝不使用裸 `fetch`；带凭证时警惕跨域重定向（§3）。
2. **危险操作正确声明 risk**：不可逆 / 外泄 / 改系统 → `risk:'dangerous'` 或 `visibility:'restricted'` 加 `confirm`；
   删库级 → `confirm:'always'`（§2）。漏标会让被注入的 LLM 直接放行。
3. **执行不可信代码 → 取 code-sandbox 服务，`available` 为假就 fail-closed**，不要裸跑（§4）。
4. **`resolveLocalPath` 不是沙箱边界**，只当工作目录起点使用（§5）。
5. **`readExternalFile` 只传入可信来源的路径**，永不传入用户 / LLM 提供的字符串（§6）。
6. 记住威胁模型：敌人是聊天中的陌生人和被注入的 LLM，不是已经取得 shell 的人（§1）。

---

## 交叉链接

- 兄弟概念：[权限两轴 / authority](../core/authority.md) · forward-ref [storage URI 文法](./storage-uri-grammar.md) ·
  forward-ref [DI 服务模型](./service-model.md)
- forward-ref 服务文档：[`services/authority`](../services/authority.md)（裁决服务全量 API）·
  [`services/storage`](../services/storage.md) · [`services/process`](../services/process.md)
- 相关插件文档：[`plugin-tool-code-runner`](../plugins/plugin-tool-code-runner.md) ·
  [`plugin-code-sandbox-os`](../plugins/plugin-code-sandbox-os.md) · [`plugin-authority`](../plugins/plugin-authority.md)
- 多用户 / 云端：搁置（未实现）
