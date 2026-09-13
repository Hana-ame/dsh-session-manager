# 设计文档：一个包，三层

> 面向想改这个包的人。使用方式看根目录 `README.md`，安装细节看 `package/INSTALL.md`。

## 1. 设计意图

管理会话这件事有两半，而它们天生是一体的：

- **一半是记忆**：协调者要知道「谁是谁的分叉」「我在等谁」「这个会话在干什么」。这些信息必须**跨进程重启存活**——否则每次重启，之前建立的关系与备注全部作废，协调者只能从零重新推断。
- **另一半是视图**：光有记录不够，还要能一眼看见关系全貌——谁挂在谁下面、哪些是分叉、哪些已经归档但还在记忆里。

于是有了这个包的三层。它们不是三个功能的堆叠，而是**同一份记录的下游**：

```
                    ┌───────────────────────────────┐
   写入 ──────────►  │ ① store.mjs                   │  ◄────── 读取
（② 观测到血缘、   │  state.json: 关系 + 备注        │        （③ 画布渲染）
   写 describe 备注）└───────────────────────────────┘
```

- ② 是这份记录的**唯一写者**（观测到的血缘 + 人工备注）；
- ③ 是这份记录的**渲染器**（画成图，并把还记着但已不在活列表里的会话画出来）；
- ① 是这份记录本身，也是两者之间唯一的契约。

把三层放进**一个包**，是因为它们共享一个数据模型。分成两个仓库/两个包时，任何字段变化都要在两边同步，而「画布读的字段」和「工具写的字段」一旦漂移，症状是画布静默地少画东西——最难查的那类 bug。

## 2. 架构总览

```
  浏览器（③ 画布）                           DSH 进程
  ┌──────────────────┐                ┌──────────────────────────────────────┐
  │ window.__Module  │  GET 同源路由   │ profile 行: @local/dsh-session-manager │
  │ Loader__.load(…) │ ─────────────► │  lib/index.js  host 半（唯一实例）      │
  │  lib/client.js   │  /session-     │      └─ readState() ──► ①              │
  │                  │   manager/state│                                       │
  │  remote.session  │ ◄───────────── │  ── Remote 命名空间（已有）             │
  │   .list()        │                │                                       │
  └──────────────────┘                │ preset 行: ../../profiles/…/lib/tools  │
                                      │  lib/tools.mjs ②（每个会话挂载一次）    │
                                      │      └─ observe()/setNote() ──► ①      │
                                      └──────────────────────────────────────┘
                                                     ①  lib/store.mjs
                                                        $DSH_HOME/session-manager/state.json
```

两条**互不依赖**的数据通路：

| 通路 | 谁走 | 传什么 | 失败时 |
|---|---|---|---|
| `remote.session.list`（已有 Remote 命名空间） | ③ | 活会话清单：id、cwd、是否 running、`parentSessionId`、`origin`、title projection | 画布报 `error:`，0 节点 |
| `GET /session-manager/state`（本包 host 半） | ③ | ① 的全部记录：备注 + 观测到的血缘 | 画布退化为「只有活会话」，标题栏写明原因 |

两条路分开是刻意的：**记录读不到，不该让活会话图也消失**。

## 3. 各层职责

### ① `lib/store.mjs` — 持久化

数据模型（`state.json`，`version: 3`）分两块，同一个文件、同一个写者：

**每会话记录 `byId[<sessionId>]`**

| 字段 | 来自 | 说明 |
|---|---|---|
| `description` | ② `session_describe` | 私有备注，trim 后截断 200 字符；`""` = 已清除 |
| `updatedAt` | ② | 备注最后一次写入时间 |
| `parentId` / `kind` | ② `session_list` 观测 | 父会话 id 与类型（`top-level` / `fork` / `subagent`） |
| `cwd` / `title` | ② `session_list` 观测 | 最后一次观测到的位置与标题 |
| `firstSeenAt` | ① | 这个包第一次记下该会话的时间 |

**委托账本 `delegations[]`**（最新在前，保留 200 条）

| 字段 | 说明 |
|---|---|
| `id` / `from` / `to` | 委托 id、委托方会话、目标会话 |
| `task` / `mode` | 交付出去的任务摘要（≤200 字符）与投递模式 |
| `status` | `pending` / `done` / `failed` / `unknown` |
| `createdAt` / `baselineSeq` | 记账时间，以及投递前目标的最后事件序号（判定切点，见 D8） |
| `settledAt` / `reply` / `note` | 结案时间、目标这一轮的答复（≤1200 字符）、结案原因或回调投递失败说明 |

读写语义（每条都有理由）：

- **读是 stat 校验的**：先 `stat` 拿 `mtimeMs:size`，与缓存比对，变了才重读。这样即使存在第二个模块实例或第二个进程在写，读者也不会拿到陈旧缓存。
- **写是串行 + 原子的**：所有写走同一条 promise 队列；落盘用「同目录临时文件 + `rename`」，崩溃不会留下半截 JSON。
- **没有变化就不写**：`observe()` 先逐条比对，全都没变就返回 `null`，跳过整次落盘。所以**一次只读的 `session_list` 在磁盘上仍然是只读的**（这正是它能被重复调用而不产生写放大的原因）。
- **迁移只做一次**：`state.json` 不存在而旧的 `descriptions.json` 存在时，读入旧备注作为初始状态；旧文件此后不再读、也从不写。
- **备注与血缘互不覆盖**：清除备注（写 `""`）只改 `description`，记录里的血缘字段照旧保留；记录只有在「备注空 **且** 没有任何血缘」时才整条删除。

`state.json` 是这个包**唯一**的持久文件。

### ② `lib/tools.mjs` — 管理工具

11 个工具按意图分四类：

| 类别 | 工具 | 写 ① 吗 |
|---|---|---|
| 观察 | `session_list`、`session_read`、`session_queue`、`session_delegations` | `session_list` 会（观测血缘）；`session_delegations` 会（结案委托，见 D8）；另两个不会 |
| 驱动 | `session_send`、`session_stop`、`session_compact`、`session_fork` | `session_send(callback)` 会记账；其余只写目标会话日志 |
| 记录 | `session_describe` | 会 |
| 模型 | `session_models`、`session_model` | 不会 |

**Plane 规则**：这一层消费 host 的 `tools`、`sessionController`、`agents`、`commands` 注册表，**自己一个服务都不发布**，所以它在 preset 组合里必须**裸放**（不能进 `isolate` realm）——进了 realm 它会去解析一个此 preset 从未填充的私有注册表，结果是工具静默地什么都不贡献。这条在 `agent.cordis.yml` 的注释里也写了一遍，因为它是「改组合时最容易踩」的那条。

### host 半 `lib/index.js` — 桥

它只有两个职责，但两个都不是可选的：

1. **让客户端半被下发**。client 模块系统只在 host Loader 的 entry 里扫描声明了 `dsh.client` 的包；preset 子树永远不被扫描。所以③必须占一行 profile entry，也就必须有一个 host 半（哪怕它什么都不做）。
2. **把①送到页面**。durable 客户端 bundle 的 `require` 表只有 `react`、`@deepseek-ai/cordis`、`dsh-client-store`、`dsh-client-ui-slots`/`-primitives`/`-dockkit` 以及其它 client bundle——**没有 host 调用桥**。动态 Cordis 包才有 `harness.handle` / `host.call`。所以这里的通道是一个同源 GET 路由。

路由契约：

```
GET|HEAD /session-manager/state
200 {"version":2,"file":"<绝对路径>","byId":{…}}
500 {"version":0,"byId":{},"error":"…"}      # 读盘失败
405 "session-manager: method not allowed"    # 其它方法
```

它是**无凭据**的（不会走到页面那条鉴权上），但**只绑在 127.0.0.1**，且返回的数据与 `<DSH_HOME>/session-manager/state.json` 完全一致——同一个本地用户本来就能读那个文件。所以它没有扩大暴露面，但它**不是**保密边界（见 §6）。

### ③ `lib/client.js` — 画布

- **形态**：classic script + `window.__ModuleLoader__.load({ id, factory })`，手写、不需要构建。`id` **必须等于包名**（`@local/dsh-session-manager`）——客户端模块系统靠它把 factory 对上 graph row；写成别的名字，`bundle … loaded without registering "<id>"` 直接失败。
- **服务依赖**：`exports.inject = ['remote', 'remote.session', 'slots']`。`remote.session` 是 `ctx.remote.$mount(...)` 挂上来的**独立 Cordis 服务**，不是 `remote` 服务的普通属性；不声明就访问会被 Cordis guard 拒绝（`cannot get property "remote.session" without inject`，面板上表现为 `error:` + 0 节点）。
- **数据合流**：`session.list` 的每一行与①的记录按 session id 合并 → `normalize(item, stored)`。**活会话日志优先，持久记录补缺**：只有 live 行没给 `parentSessionId` 时才用记录里的。
- **图 = 活会话 ∪ remembered**：① 里还记着、但已经不在活列表里的会话（归档/删除过的）画成**虚线灰底的 `remembered` 节点**——它们正是「管理者的记忆」，不该因为源会话消失而消失。
- **作用域**：只画当前工作区。用与侧栏**完全相同**的推导（`items.find(item => item.sessionIds.includes(current))`），保留「工作区登记的 ∪ cwd 在工作区路径之下 ∪ 已保留会话的后代」；当前会话是子会话/分叉时沿 `parentSessionId` 上溯。**找不到工作区就画 0 个节点并写明原因**，绝不退回「全部工作区」。
- **纯函数可测**：作用域推导被写成无副作用的纯函数，测试用 `new Function` 从**出货文件里切出来断言**——断言跑的是真 bundle，helper 的注释标记一移动测试就报错，而不是静默通过。

## 4. 关键决策与取舍

### D1 一个包，两个挂载点（被迫，不是选择）

```
$DSH_HOME/profiles/node_modules/@local/dsh-session-manager/   ← 包本体（唯一拷贝）
$DSH_HOME/.agent-presets/session-manager/                     ← preset，行指回上面
$DSH_HOME/profiles/web/cordis.patch.yml                       ← 一行 Loader entry（③）
```

preset 行的解析规则（`@deepseek-ai/dsh-agent-presets`）决定了工具行只能这么写：

- 以 `.` 开头 → 相对**组合自己所在目录**解析；
- **裸包名 → 只从 harness 安装目录解析**（不是从 profile 的 `node_modules`）；
- 绝对路径 → `file:` URL。

所以 `../../profiles/node_modules/@local/dsh-session-manager/lib/tools.mjs` 是唯一既能指到已安装的包、又不必把工具再复制一份的写法。**代价**：preset 不再自足——只拷 `preset/` 而不装包，组合会挂载失败。`install.sh` 因此把两者当一件事装。

（已验证：`ctx.agentPresets.standingKeyFor('session-manager')` 真实组合通过。）

### D2 ① 是模块，不是 Cordis 服务

直觉上「跨会话的持久化」是 host plane，该发布成服务。这里没这么做，因为①有两个消费者，而它们**处在两个不同的 scope**：

- ② 在 preset 子树里，每个会话挂载一次；
- host 半在 profile 里，全进程一次。

把①做成服务，就要面对「preset 的 isolate realm 里的服务对外不可见」这条规则（`agentPresets.serviceFor` 就是为绕过它而存在的），还要处理两个消费者拿到不同实例的问题。而①的真实需求只是**同一份文件 + 同一份缓存**：ESM 模块在同一进程里本来就按解析后的绝对路径唯一，两个消费者 import 的是同一个文件，于是天然共享实例。写路径又是 stat 校验 + 原子 + 串行，即使将来真的出现两个实例（比如有人复制了包）也不会互相破坏。

**代价**：①没有 Cordis 的生命周期（不会被 stop 卸载），也不出现在服务目录里。对一个「纯数据 + 纯函数」的层来说，这反而更简单。

### D3 画布的第二个数据源走同源 HTTP 路由

理由见 §3 host 半：durable bundle 没有 host 调用桥。可选项与取舍：

| 方案 | 结论 |
|---|---|
| `harness.handle` / `host.call` | 只属于**动态** Cordis 包，durable bundle 拿不到 |
| 自定义 Remote 命名空间（Typert） | 可行但要手写 schema/协议，收益不抵复杂度 |
| **同源 GET 路由** | 选它。shipped 的 `client-hmr` 也是这么把 `/plugins/events` 给页面的 |
| session projection | 投影按会话事件序缓存，而备注活在会话日志之外——改了备注不会让序号前进，值会陈旧。**不合适** |

**代价**：多了一个 HTTP 面（无凭据、仅本机），以及一次 4 秒轮询（与画布原有刷新节奏一致，没有另加 SSE）。

### D4 关系数据是「观测式」持久化

关系从哪来？不新造一套「关系 API」，而是让 `session_list` 把它**已经观测到**的血缘写进①：id、父、类型、cwd、标题。协调者每列一次表，记忆就固化一次。

**代价**：`session_list` 从一个纯读操作变成「可能写盘」的操作。缓解：只在血缘真的变化时才写（D2/① 的「无变化不写」），且失败不隐藏列表本身（返回里加一行 `Warning:`）。

### D5 画布只画当前工作区

一个 DSH 进程可能同时跑好几个项目；把它们的会话画在一张图上，协调者需要的信息会被无关节点淹没。作用域用侧栏同款推导，**并且宁可空着也不退回「全部」**——静默地把别的工作区的会话混进来，比空图更糟。

**代价**：跨工作区的关系（比如一个 fork 的分叉点在本工作区、父会话在别处）不会被画出来；① 里仍然记着它。

### D6 `session_compact` 驱动目标自己的 `/compact`

`@deepseek-ai/dsh-command-compact` 注册在**每个 preset 自己的 compaction realm 里**，所以它执行时的 `ctx.compaction` 就是**目标会话自己的**引擎。于是工具只做一件事：

```js
await ctx.commands.execute({ id: sessionId }, '/compact', [], signal)
```

`CommandRuntime.execute` 的第一个参数是**裸 agent（只有 id）**，作用域注册按 agent 解析——这正是「从外部替某个会话执行它自己的命令」的机制，和浏览器里跑命令走的是同一条路（因此不需要把 compaction 的抽象接口抄一遍）。

**代价**：目标必须是**活着的**（冷会话没有 agent，也就没有作用域注册），并且要空闲（引擎自己会以 `busy` 拒绝）。想要「连冷会话也能压」，就得先 `resolveAgent` 唤醒它——那会多一个副作用，暂不默认做。

### D7 `session_queue` 先 abort 再 break

inbox 只活在实时控制流里。`sessionController.control(signal)` 的第一帧是完整 baseline（带所有活会话的队列），取走目标那一项即可。但有一个陷阱：

```js
for await (const frame of controller.control(abort.signal)) {
  … 取出 baseline …
  abort.abort()   // ← 必须在 break 之前
  break
}
```

`break` 会等这个流自己取消，而那个取消信号**正是我们手里的这一个**；不先 abort 就 break，会死锁在 `iterator.return()` 上。测试里用一个「等 abort 才结束」的假生成器把这条钉死。

### D8 委托回调 = 无状态轮询 + 读目标的持久日志

需求是：`session_send` 把活派出去之后，委托方要能**被动**收到"对方做完了/失败了 + 它说了什么"。四种做法：

| 方案 | 为什么不用 |
|---|---|
| 对方主动调一个 `session_reply` 工具 | 要求被委托的会话**也**跑在会话管理模式里。可现实中委托目标通常是 `standard`/`ptc` 编码会话，它们**没有**这个包的工具；这条路的适用范围比看起来小得多 |
| 监听 host 事件 `session/event` / `agent/inbox/claimed` | 机制上最漂亮（`session/event` 是每条会话事件提交后的广播，`agent/inbox/claimed` 正好是"消息被这一轮接纳"），但事件是**按 scope 过滤**的（`this: Scoped<Session>`），委托方 preset 的 scope 未必收得到别的 preset 下会话的事件；而且监听器是内存状态，进程一重启就没了 |
| `sessionController.follow()` 流 | 每个委托要握住一条流，退出时要处理"先 abort 再 break"的顺序陷阱（见 D7），重启后还得重放游标 |
| **轮询目标的持久日志**（选它） | 无状态：判定完全由 `baselineSeq` + 目标日志推导，重启后挂载时重新开始轮询即可，pending 的委托自动续上；而且极易测试（把事件数组喂进去断言结论） |

判定规则（正确性的全部就在这两行）：

- **我们的提示 = `baselineSeq` 之后的第一条用户消息**（`source.kind === 'user'`）；
- **结局 = 那条消息之后的第一个 `turn/end`**；两者之间的最后一条 `assistant/message` 文本就是答复。

**为什么必须等"接纳"**：`mode:"queue"` 时目标可能正跑着上一轮，那个 `turn/end` 与你的委托无关。若不以"出现那条用户消息"为界，会在目标的上一轮结束时误报成功并附上**别人的**答复。这条规则在测试里被单独钉住（`a turn that ends before the prompt is admitted leaves it pending`）。

**代价**：5 秒粒度（不是即时）；每个 tick 只在存在 `pending` 时才读盘，所以空闲代价约为一次内存判断。若部署里没有 `timer` 服务，推送这条腿不启用，但 `session_delegations` 的拉取仍然工作（它读之前强制跑一遍检查）——推送是尽力而为，账本才是真相。

## 5. 四条典型数据流

**A. 协调者列一次表**

```
② session_list(scope="workspace")
   ├─ sessionController.list()                 → 活会话行（含 title/modelSelection projection）
   ├─ readState()                              → ① 的备注（显示 note:）
   ├─ observe(rows)                            → 血缘有变化才写 ①（原子 + 串行）
   └─ ok(lines)                                → 模型可见的文本
```

**B. 协调者写一条备注**

```
② session_describe({sessionId, description})
   ├─ setNote() → change(…) → flush()          → ① 落盘（临时文件 + rename）
   └─ ok("… (persisted in <path>)")
```

**C. 画布刷新一次（每 4 秒）**

```
③ Promise.all([ fetchSessions(), fetchStored() ])   ← 两条通路各自失败互不拖累
   ├─ live  = session.list 行  → normalize(item, stored[id])
   ├─ orphan = ① 里有、live 里没有 → normalizeStored(id, rec)   → remembered 节点
   ├─ workspaceOf(useWorkspaces.items, currentId, live)
   ├─ scopeToWorkspace(live ∪ orphan, workspace, currentId)
   └─ buildLayout → drawScene（备注画在节点第 3 行，remembered 用虚线灰底）
```

**D. 一次委托与它的回调**

```
② session_send({sessionId: T, text, callback: true})
   ├─ inspect(T)                      → baselineSeq = T 的最后序号
   ├─ prompt(T, queue)                → 提示进入 T 的 inbox
   ├─ addDelegation({from: me, to: T, task, baselineSeq, status: 'pending'})   → ① 落盘
   └─ ok("… callback dlg-… registered")

   … 若干秒后，② 的轮询 tick（timer 服务，每 5 秒且仅在存在 pending 时读盘）
   ├─ readState()                     → 取出 pending 委托
   ├─ inspect(T)                      → T 的日志
   ├─ readDelegationOutcome(events, baselineSeq)
   │     第一条 user/message（接纳）→ 之后的第一个 turn/end（结局）
   │     中间的 assistant/message 文本 = 答复
   ├─ settleDelegation(id, {status, reply, note})   → ① 落盘（只接受仍 pending 的记录）
   └─ prompt(me, queue, "[委托回调] …")             → 结果排进委托方自己的 inbox

   （任一步失败都不影响别的：目标读不到就保持 pending，通知投不出去就在 note 里写明）
```

## 6. 边界与已知取舍

- **记录不是保密边界**：`state.json` 与那条 state 路由对同一个本地用户可读。它是**归属边界**——除了这个包，没有别的东西读写它；备注也从不写进任何会话日志，所以侧栏、会话列表、轨迹视图和其他 agent 都看不到。
- **`session_compact` 改写目标历史**：可压缩段被替换成一个摘要节点，事务写进目标日志。除分叉或重来之外不可撤销。
- **画布只显示当前工作区**，跨工作区的关系不在图上（① 里仍在）。
- **记录不随会话删除**：① 按 session id 存，会话被删/归档后条目还在（画布画成 `remembered`）。不自动清理，避免误删仍在用的备注。
- **委托可能一直 `pending`**：如果那条提示始终没被目标接纳（它一直忙），或者目标的日志被压缩/清理掉了判定切点，回调就不会结案。推送是尽力而为，`session_delegations` 的账本才是真相，必要时用 `dismiss` 收尾。
- **只看得见本进程**：`sessionController` 是本进程的会话表。
- **子会话不由本模式驱动**：`origin:"subagent"` 的会话被 ownership fence 拦住，只有它的活父会话能驱动；分叉不受此限制。
- **未做**：把 remembered 节点的备注同步回目标会话标题；跨工作区视图；冷会话压缩（需先唤醒）；在画布上画委托/回调边；`unknown` 状态的自动超时（目前只有人工 `dismiss`）。

## 7. 改动指南（哪一步要重启）

| 改什么 | 生效方式 |
|---|---|
| `lib/client.js`（③） | `client-hmr` 每 500ms 轮询 bundle 的 mtime/size，变了就 SSE 热替换，**不用重启** |
| `lib/store.mjs` / `lib/tools.mjs` | 存盘即生效：preset 每次挂载都重新 import。想立刻验证用 `standingKeyFor` |
| `lib/index.js`（host 半）、`package.json`、preset 组合、profile 行 | **要重启**（这些是启动时扫描/组合的东西） |

新增一个工具：写进 `lib/tools.mjs` 并 `ctx.tools.register(...)`，补 `package/test/tools.test.mjs`，把工具名加进 `agent.cordis.yml` 的 persona 清单与 `preset.yml` 描述。
新增一个持久字段：在 `lib/store.mjs` 的 `blankRecord`/`normalizeRecord`/对应 writer 三处同时加，`STATE_VERSION` 递增；画布按需在 `normalize`/`normalizeStored` 里消费。
新增一种持久记录（像 `delegations` 那样）：同样的三处 + `parseState` 里补一段读取，并且**所有既有 writer 都必须 `{...state, …}` 地展开**——否则一次备注写入就会把这类新记录抹掉（`tools.test.mjs` 里的 `note write kept ledger` 就是钉这条的）。
改动回调判定规则（D8）：规则集中在 `readDelegationOutcome(events, baselineSeq)` 一个纯函数里，改它必须同时改测试里的脚本化日志。

## 8. 怎么验证

```sh
node package/test/tools.test.mjs    # ② 与 ①：77 项
node package/test/scope.test.mjs    # ③ 的纯函数：18 项
dsh --profile web --dump-config | grep -A1 session-manager   # profile 行进了组合
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/session-manager/state   # 200 = host 半活着
```

preset 组合的正确性由 **`ctx.agentPresets.standingKeyFor('session-manager')`** 判定：它真实组合一遍插件子树（等同一次会话启动，只是不建 agent），能拒掉「行解析不到 / config 非法 / 某行从未激活 / 把服务发布进根 realm」四种失败。roster 的 `broken` 字段**不算**验证（它只做形状检查）。

浏览器的渲染结果只能由页面自己确认：刷新页面 → 侧栏底部三节点图标 → 面板应显示当前工作区的会话图、备注与 remembered 节点。
