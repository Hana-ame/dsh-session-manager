# 设计文档：一个包，①/② 两层 + 两个外围模块

> 面向想改这个包的人。使用方式看根目录 `README.md`，安装细节看 `package/INSTALL.md`。
>
> 0.3.0 之前这里还有第三层——一个渲染会话关系图的浏览器画布（`lib/client.js` + 一个只为它存在的 host 半 `lib/index.js` + profile 里的一行 Loader entry）。它没做好、可用性不高，整层已被删除；本文档只描述现在还在的模块。涉及它的历史决策（D3「画布数据走同源路由」、D5「画布只画当前工作区」）也一并删除。
>
> 之后新增的 ④ `lib/ask-bridge.mjs` 是**另一条线**：它不改 ①/② 的数据模型，只补上「被委派会话提问无人应答」这个缺口，走 host 平面单独挂载。见 §3 的 ④ 小节与 §4 的 D8。
>
> 此外还有一个**不属于 ①/② 数据模型**的 preset 行 `lib/loop.mjs`（`/loop` 命令 + 每会话定时巡检，见 §3 的 `/loop` 小节）。它与 ② 同层挂载、同样不发布服务，只是**不在 ①/② 的记账链路里**：它只读 ①，从不写。
>
> **编号说明**：① 持久化、② 管理工具、③ **已删除**的 0.2 画布、④ 提问桥。`loop.mjs` 是后来加的，为不冒用已退役的 ③，文中直接称其文件名。

## 1. 设计意图

管理会话这件事的核心只有一件：**记忆**。协调者要知道「谁是谁的分叉」「我在等谁」「这个会话在干什么」，而这些信息必须**跨进程重启存活**——否则每次重启，之前建立的关系与备注全部作废，协调者只能从零重新推断。

于是有了这个包的两层，它们是**同一份记录的生产者与消费者**：
```
                    ┌─────────────────────────────────────────────┐
   写入 ──────────►  │ ① store.mjs                                │  ◄────── 读取
（② 观测到血缘、   │  state.json: 关系+备注+delegation ledger    │        （② session_list 报告）
   写备注；④ 记转交）└─────────────────────────────────────────────┘
```

- ② 是这份记录**主要的写者与读者**（观测到的血缘 + 人工备注 + delegation ledger），但**不是唯一写者**：④ 作为「提问转交」的落账方，也会往委托行的 `note` 里追加一行（转交成功/失败、超时放行）——它写的是 ② 已经建好的那条委托记录，不新建字段、不改数据模型；
- ① 是这份记录本身，也是各层之间唯一的契约。

把两层放进**一个包**，是因为它们共享一个数据模型。分成两个包时，任何字段变化都要在两边同步，而「工具写的字段」和「工具读的字段」一旦漂移，症状是最难查的那类静默错误。

## 2. 架构总览

```
   DSH 进程
   ┌──────────────────────────────────────────────────────────────┐
   │ preset 行: ../../profiles/…/@local/dsh-session-manager/lib/   │
   │            tools.mjs                                          │
   │  lib/tools.mjs ②（每个会话挂载一次）                          │
   │      ├─ observe()/setNote()/addDelegation() ──► ①             │
   │      └─ sessionController / agents / commands / tools         │
   │                                                               │
   │  lib/loop.mjs（preset 的 tool-loop 行，每个会话挂载一次）      │
   │      ├─ readState()（只读 ①，从不写）                          │
   │      └─ commands / sessionController / agents / timer         │
   │                                                               │
   │ host patch 行: $DSH_HOME/cordis.patch.yml                     │
   │  lib/ask-bridge.mjs ④（每进程恰好一次）                        │
   │      ├─ readState()/noteDelegation() ─────────► ①             │
   │      └─ userQuestions / sessionController / inbox 事件        │
   │                                                               │
   │  ①  lib/store.mjs                                             │
   │      $DSH_HOME/session-manager/state.json                     │
   └──────────────────────────────────────────────────────────────┘
```

包的边界：没有 profile 行、没有 HTTP 路由、没有下发给浏览器的任何东西。（④ 虽然由一行 host patch 挂载，但它仍属于这个包——文件就在包里，只是**挂载点**不同：② 与 `/loop` 是每会话，④ 是每进程。）

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

**delegation ledger `delegations[]`**（最新在前，保留 200 条）

| 字段 | 说明 |
|---|---|
| `id` / `from` / `to` | 委托 id、委托方会话、目标会话 |
| `task` / `mode` | 交付出去的任务摘要（≤200 字符）与投递模式 |
| `status` | `pending` / `done` / `failed` / `unknown` |
| `createdAt` / `baselineSeq` | 记账时间，以及投递前目标的最后事件序号（判定切点，见 D6） |
| `settledAt` / `reply` / `note` | 结案时间、目标这一轮的答复（≤1200 字符）、结案原因或回调投递失败说明 |

读写语义（每条都有理由）：

- **读是 stat 校验的**：先 `stat` 拿 `mtimeMs:size`，与缓存比对，变了才重读。这样即使存在第二个模块实例或第二个进程在写，读者也不会拿到陈旧缓存。
- **写是串行 + 原子的**：所有写走同一条 promise 队列；落盘用「同目录临时文件 + `rename`」，崩溃不会留下半截 JSON。
- **没有变化就不写**：`observe()` 先逐条比对，全都没变就返回 `null`，跳过整次落盘。所以**一次只读的 `session_list` 在磁盘上仍然是只读的**（这正是它能被重复调用而不产生写放大的原因）。
- **迁移只做一次**：`state.json` 不存在而旧的 `descriptions.json` 存在时，读入旧备注作为初始状态；旧文件此后不再读、也从不写。
- **备注与血缘互不覆盖**：清除备注（写 `""`）只改 `description`，记录里的血缘字段照旧保留；记录只有在「备注空 **且** 没有任何血缘」时才整条删除。

`state.json` 是这个包**唯一**的持久文件。

### ② `lib/tools.mjs` — 管理工具

15 个工具按意图分五类：

| 类别 | 工具 | 写 ① 吗 |
|---|---|---|
| 观察 | `session_list`、`session_read`、`session_queue`、`session_delegations` | `session_list` 会（观测血缘）；`session_delegations` 会（结案委托或 dismiss 删记录时，见 D6）；另两个不会 |
| 驱动 | `session_send`、`session_stop`、`session_compact`、`session_fork`、`session_create`、`session_archive` | `session_send(callback)` 会记账、`session_create` 会记下新会话；其余只写目标会话日志或 workspace 注册表 |
| 排队消息改写 | `session_queue_manage` | 不会（改写的是目标 inbox 里尚未投递的条目，不是 ①） |
| 记录 | `session_describe`、`session_rename` | 会（`session_rename` 只写 `title` 一个字段） |
| 模型 | `session_models`、`session_model` | 不会 |

**Plane 规则**：这一层消费 host 的 `tools`、`sessionController`、`agents`、`commands`、`workspaceRegistry` 注册表，**自己一个服务都不发布**，所以它在 preset 组合里必须**裸放**（不能进 `isolate` realm）——进了 realm 它会去解析一个此 preset 从未填充的私有注册表，结果是工具静默地什么都不贡献。这条在 `agent.cordis.yml` 的注释里也写了一遍，因为它是「改组合时最容易踩」的那条。

### `lib/loop.mjs` — `/loop` 会话内定时巡检

**它解决的问题**：委托是异步的，协调者不盯着就不知道谁结案了。但让 agent 自己反复 `session_read` / `session_delegations` 去轮询，既费 token 又会「喷废话」。

**它的做法**：`/loop` 是注册进 host `commands` 注册表的**人类斜杠命令**，外加一个**每会话一个**的定时器（默认 120 s，`/loop <秒数>` 可改，`/loop stop` 停，`/loop status` 看）。每一轮：

1. 用 `readState()` 读 ①——它是 ① 的**纯读接口，没有副作用**，这一点是有意选的：`session_delegations` 工具在读之前会先跑一遍结案检查、可能顺带投递回调通知，巡检不该有这种放大效应；
2. 用 `sessionController.list()` 读会话表——也是只读；
3. 只有在发现「新结算的委托」或「疑似卡住（running 但长时间无新进展）」时才用一条 `[LOOP patrol]` 排队消息唤醒**它自己的会话**；无事发生则完全静默——没有消息、没有 LLM 轮次。

**规则**（既写在这里，也重复在 tick 消息里）：极简汇报，每类一行；唯一允许的写是让 agent 自己用 `session_delegations({dismiss})` 清掉**已经向用户汇报过**的已结算委托；绝不 dismiss `pending`/`unknown`/拿不准的条目；绝不自动派活、重投任务或 `session_stop`。

**生命周期与幂等**：定时器按会话 id 存在内存里，重跑 `/loop` 是**替换**而不是叠加；都经 `ctx.effect` 注册，所以 ctx 卸载（preset 卸载 / 进程退出）会一并清理；owner 的 agent 不再存活时定时器**自动停**。它**不跨进程重启存活**——重启后用户重新 `/loop`，delegation ledger 本身是持久的，已经报过的东西不会丢。

**Plane 规则**：与 ② 相同——消费 host 注册表、不发布服务，因此组合里必须**裸放**，进了 `isolate` realm 会解析到没人填过的私有注册表，`/loop` 会静默失效。

### ④ `lib/ask-bridge.mjs` — 被委派会话的提问桥

**它解决的问题**：`ask_user_question` **没有超时**。`userQuestions` seam 只拦「runtime 拥有的子 agent」（`DELEGATED_CALLER`），而 `session_send` 委派出去的会话是它自己的 runtime **root**，于是绕过这道保护，走到 `user-questions/request` waterfall；这条 waterfall 只有**提问者自己那个会话的浏览器**能应答。没人在看那个会话，工具调用就永久挂住。真实故障：一个被委派的 worker 卡了 **107 分钟**，而它的任务其实早已 15/15 全绿完成。

**它的做法**：被委派的会话遇到问题，**无条件转交回委托方，由委托方决定**。本层不替它做任何决定。

1. `prepend` 注册在 host 平面的 `user-questions/request` 上——必须在 `api-remotes` 转发器**之前**拿到决定权，否则请求会被 park 在一个并不存在的浏览器上；
2. **提问者是谁的 target 就转给谁**：取 delegation ledger 里 target 为它的最新一条委托，**pending 与已结算的都认**（不带 `callback: true` 的后续任务不记新行，但委托方还是它）。不是任何委托 target 的会话原样 `next()`——前台人类提问完全不变，自己的浏览器永远优先；
3. 把问题原文 + 选项（推荐项标注）+ 答复方式，通过 `sessionController.prompt`（`mode: "queue"`，不打断委托方当前轮次）投进**委托方**的会话；`requestId` 由委托 id + 问题摘要 + 序号**派生**，直接复用控制器的 `hasPromptRequest` 去重，不引入第二套投递源，也不新增任何 session-manager 工具；
4. 委托方用一条普通 `session_send` 回复；该用户消息落进 worker 的 inbox 时会 emit `agent/inbox/inserted`，本层据此把答复文本作为提问结果返回，解锁那个卡住的工具调用。一条答复可一行一个 `id=...` 分答多个问题；一个 worker 有多个问题在等时，回复可用 `[提问答复 ask=<askId>]` 指明答的是哪一个，否则默认答最早那一个；
5. **没有 grace、没有默认答案**。默认 `timeoutMs: 0` = 一直等下去，直到委托方决定。唯一的其它出口都是**让工具调用失败**而不是假装有了答案：worker 那轮被取消（abort）、投递失败（委托方会话不在本进程）、或你显式设了正向 `timeoutMs` 而它到期。

**它记什么**：转交与答复写进委托行的 `askLog`（`session_delegations` 渲染成 `asked:` 行）。不写 `note`——`settleDelegation` 会把 `note` 覆盖成 `turn ended completed`，写在那里等于没记。

**Plane 规则**：必须 host 平面。被委派的 worker 通常跑**别的 preset**（`ptc`/`standard`…），preset 作用域的监听器根本收不到它的提问；即使同一个 preset，也是每会话挂一份，会重复投递。它不发布服务，所以不需要 `isolate` realm，也不需要 `package.json` 导出——host patch 行用相对路径直接指到文件。

**与既有投递机制的兼容**：④ 复用 ② 的派生 `requestId` 思路（`preset-delegation-ask-<dlgId>-<digest>-<seq>`，与结算通知的 `preset-delegation-<dlgId>` 前缀不同、不会互相去重），不碰 `session_send`/`session_delegations`/`session_stop`/`session_queue_manage`，也不碰 `lib/loop.mjs`。

## 4. 关键决策与取舍

### D1 一个包，两个安置点（被迫，不是选择）

```
$DSH_HOME/profiles/node_modules/@local/dsh-session-manager/   ← 包本体（唯一拷贝）
$DSH_HOME/.agent-presets/session-manager/                     ← preset，行指回上面
```

preset 行的解析规则（`@deepseek-ai/dsh-agent-presets`）决定了工具行只能这么写：

- 以 `.` 开头 → 相对**组合自己所在目录**解析；
- **裸包名 → 只从 harness 安装目录解析**（不是从 profile 的 `node_modules`）；
- 绝对路径 → `file:` URL。

所以 `../../profiles/node_modules/@local/dsh-session-manager/lib/tools.mjs` 是唯一既能指到已安装的包、又不必把工具再复制一份的写法。**代价**：preset 不再自足——只拷 `preset/` 而不装包，组合会挂载失败。`install.sh` 因此把两者当一件事装。

（已验证：`ctx.agentPresets.standingKeyFor('session-manager')` 真实组合通过。）

### D2 ① 是模块，不是 Cordis 服务

直觉上「跨会话的持久化」是 host plane，该发布成服务。这里没这么做：① 的消费者只有 ②，而 ② 在 preset 子树里，每个会话挂载一次。把它做成服务，就要面对「preset 的 isolate realm 里的服务对外不可见」这条规则（`agentPresets.serviceFor` 就是为绕过它而存在的），还要处理每次挂载拿到不同实例的问题。而 ① 的真实需求只是**同一份文件 + 同一份缓存**：ESM 模块在同一进程里本来就按解析后的绝对路径唯一，同一个 preset 的多次挂载 import 的是同一个文件，于是天然共享实例。写路径又是 stat 校验 + 原子 + 串行，即使将来真的出现两个实例（比如有人复制了包）也不会互相破坏。

**代价**：① 没有 Cordis 的生命周期（不会被 stop 卸载），也不出现在服务目录里。对一个「纯数据 + 纯函数」的层来说，这反而更简单。

### D3 关系数据是「观测式」持久化

关系从哪来？不新造一套「关系 API」，而是让 `session_list` 把它**已经观测到**的血缘写进 ①：id、父、类型、cwd、标题。协调者每列一次表，记忆就固化一次。

**代价**：`session_list` 从一个纯读操作变成「可能写盘」的操作。缓解：只在血缘真的变化时才写（见 ① 的「无变化不写」），且失败不隐藏列表本身（返回里加一行 `Warning:`）。

### D4 `session_compact` 驱动目标自己的 `/compact`

`@deepseek-ai/dsh-command-compact` 注册在**每个 preset 自己的 compaction realm 里**，所以它执行时的 `ctx.compaction` 就是**目标会话自己的**引擎。于是工具只做一件事：

```js
await ctx.commands.execute({ id: sessionId }, '/compact', [], signal)
```

`CommandRuntime.execute` 的第一个参数是**裸 agent（只有 id）**，作用域注册按 agent 解析——这正是「从外部替某个会话执行它自己的命令」的机制，和浏览器里跑命令走的是同一条路（因此不需要把 compaction 的抽象接口抄一遍）。

**代价**：目标必须是**活着的**（冷会话没有 agent，也就没有作用域注册），并且要空闲（引擎自己会以 `busy` 拒绝）。想要「连冷会话也能压」，就得先 `resolveAgent` 唤醒它——那会多一个副作用，暂不默认做。

### D5 `session_queue` 先 abort 再 break

inbox 只活在实时控制流里。`sessionController.control(signal)` 的第一帧是完整 baseline（带所有活会话的队列），取走目标那一项即可。但有一个陷阱：

```js
for await (const frame of controller.control(abort.signal)) {
  … 取出 baseline …
  abort.abort()   // ← 必须在 break 之前
  break
}
```

`break` 会等这个流自己取消，而那个取消信号**正是我们手里的这一个**；不先 abort 就 break，会死锁在 `iterator.return()` 上。测试里用一个「等 abort 才结束」的假生成器把这条行为固定下来。

### D6 callback = 无状态轮询 + 读目标的持久日志

需求是：`session_send` 把活派出去之后，委托方要能**被动**收到"对方做完了/失败了 + 它说了什么"。四种做法：

| 方案 | 为什么不用 |
|---|---|
| 对方主动调一个 `session_reply` 工具 | 要求被委托的会话**也**跑在会话管理模式里。可现实中委托目标通常是 `standard`/`ptc` 编码会话，它们**没有**这个包的工具；这条路的适用范围比看起来小得多 |
| 监听 host 事件 `session/event` / `agent/inbox/claimed` | 机制上最漂亮（`session/event` 是每条会话事件提交后的广播，`agent/inbox/claimed` 正好是"消息被这一轮接纳"），但事件是**按 scope 过滤**的（`this: Scoped<Session>`），委托方 preset 的 scope 未必收得到别的 preset 下会话的事件；而且监听器是内存状态，进程一重启就没了 |
| `sessionController.follow()` 流 | 每个委托要握住一条流，退出时要处理"先 abort 再 break"的顺序陷阱（见 D5），重启后还得重放游标 |
| **轮询目标的持久日志**（选它） | 无状态：判定完全由 `baselineSeq` + 目标日志推导，重启后挂载时重新开始轮询即可，pending 的委托自动续上；而且极易测试（把事件数组喂进去断言结论） |

判定规则（正确性的全部就在这两行）：

- **我们的提示 = `baselineSeq` 之后的第一条用户消息**（`source.kind === 'user'`）；
- **结局 = 那条消息之后的第一个 `turn/end`**；两者之间的最后一条 `assistant/message` 文本就是答复。

**为什么必须等"接纳"**：`mode:"queue"` 时目标可能正跑着上一轮，那个 `turn/end` 与你的委托无关。若不以"出现那条用户消息"为界，会在目标的上一轮结束时误报成功并附上**别人的**答复。这条规则在测试里被单独钉住（`a turn that ends before the prompt is admitted leaves it pending`）。

**代价**：5 秒粒度（不是即时）；每个 tick 只在存在 `pending` 时才读盘，所以空闲代价约为一次内存判断。若部署里没有 `timer` 服务，推送这条腿不启用，但 `session_delegations` 的拉取仍然工作（它读之前强制跑一遍检查）——推送是尽力而为，delegation ledger 才是真相。

### D7 新建会话：底层是 `workspaceId` 异或 `cwd`，所以工具自己判一次

`sessionController.create` 的请求里 `workspaceId` 与 `cwd` **互斥**（同时给直接 `gateway/bad-request`），而且只有 `workspaceId` 那条路会 `attachSession` 进工作区注册表——走 `cwd` 创建的会话**不属于任何工作区**。UI 的工作区列表只认注册表。

所以 `session_create` 的策略是「能挂就挂」：先 `workspaceRegistry.resolveByPath(cwd)`，**只有当返回的 `workspace.path` 恰好等于请求的 `cwd`** 时才用 `workspaceId`（此时 cwd 本就是工作区根目录，语义等价，还额外拿到归属），否则原样传 `cwd` 保住精确目录，并在结果里明说「未挂进任何工作区」。这样既不让新建的会话在侧栏里失踪，也不牺牲 cwd 精度。

**代价**：一次额外的工作区查询；以及当 cwd 是工作区子目录时「挂进工作区」与「精确 cwd」不可兼得——这是底层 API 的互斥决定的，不是这里的选择。另外 `session_create` 与 `session_fork` 的定位必须写清：**fork 继承历史与 preset，create 从空白开始**，所以「要一份新的活」用 create，「在同一份上下文上分两条路」才用 fork。

### D8 ④ 提问桥走 host 平面，且必须排在 `api-remotes` 之前

三个约束共同决定了 ④ 的形态，每一个都不能换：

1. **必须在 host 平面。** 被委派的 worker 通常跑的是**别的 preset**（`ptc`/`standard`…），preset 作用域的监听器根本收不到它的 `user-questions/request`；同一个 preset 的多次挂载还会各拿一份，导致重复投递。只有 host 平面「每进程一份」的监听器能看见所有会话的提问，再由它按「提问的 agent 是不是某条 pending 委托的 target」自行判断该不该接管。
2. **必须 `prepend`。** `api-remotes` 也在 host 平面注册同一个 waterfall，它的做法是把请求 push 进队列等浏览器应答（`forwardWaterfall`）。排在它后面就意味着请求先被 park 在一个不存在的浏览器上——永远等不到。`prepend` 让我们先拿到决定权。
3. **必须复用既有投递原语。** 转交用 `sessionController.prompt`（与结算回调同一个），`requestId` 从委托 id + 问题摘要**派生**（`preset-delegation-ask-<dlgId>-<digest>`），从而直接吃到控制器的 `hasPromptRequest` 去重——不引入第二套投递源，也不改 `tools.mjs`。

**为什么先给会话自己的 UI 一次机会**：④ 存在的理由是「没人看那个会话」，而不是「不许人看」。所以监听器立即 `next()`（让 api-remotes 与真实浏览器照常接管），把 UI 的答复与 grace 计时器赛跑；UI 赢了就完全按原行为返回，委托方不被打扰。这样**前台人类交互零变化**，只有「确实没人答」才升级为转交。

**代价与已知边界**：需要一个 grace 窗口（默认 15 s）才升级，所以最坏情况下多等这么久；转交后委托方也可能一直不回，因此还有第二个窗口（默认 3 分钟）到点按默认放行。两个窗口都可配置，`timeoutMs: 0` 可整体关掉。（未验证：转交通知在委托方**正忙**时以 `mode: "queue"` 排队，确实不会打断它的当前轮次，但也因此可能等到那一轮结束后才被看见——这正是把第二个窗口设为分钟级而非秒级的原因。）

### D9 `/loop` 是会话内的定时器，不是包的守护进程

「等委托人做完」这件事天然需要被唤醒，但把它做成包级别的后台守护进程有三个问题：它要自己的生命周期、要为「哪个会话关心哪条委托」维护订阅关系、还会在没人看的时候持续烧资源。

所以 `/loop` 反过来：**定时器属于发起它的那个会话**，只是替它做一轮**纯读**的巡检，有发现才叫醒它自己。

- **默认静默**：没有发现就什么都不投——不产生消息、不产生 LLM 轮次。这是它敢 120 秒一轮的前提。
- **只建议、不代劳**：唯一的写动作是让 agent 自己 `dismiss` **它已经向用户汇报过**的已结算委托；`pending`/`unknown` 一律不动。插件自己**不做**任何派活、重投、`session_stop`。
- **不跨重启**：定时器和「已经报过哪些 id」都在内存（`surfaced` / `stuckReportedAt` 两个集合），进程重启即消失——用户重新 `/loop` 之后，历史条目可能再报一次。持久的是 delegation ledger 本身，一条都不会丢；`surfaced` 只用来在本进程内去重，并且每轮会按 delegation ledger 现有 id 修剪（delegation ledger 里已经没有的委托不会再占位）。

**代价**：它是**每会话**的，所以开两个协调会话就会有两个巡检定时器（各自只读 delegation ledger，不会重复投递）；也因为它只读不写，巡检不会推进任何状态——想推进必须由 agent 自己动手。

## 5. 三条典型数据流

**A. 协调者列一次表**

```
② session_list(scope="workspace")
   ├─ sessionController.list()                 → 活会话行（含 title/modelSelection projection）
   ├─ readState()                              → ① 的备注（显示 note:）
   ├─ observe(rows)                            → 血缘有变化才写 ①（原子 + 串行）
   ├─ setTitle(id, title)                      → 只在该字段变化时写 ①
   └─ ok(lines)                                → 模型可见的文本
```

**B. 协调者写一条备注**

```
② session_describe({sessionId, description})
   ├─ setNote() → change(…) → flush()          → ① 落盘（临时文件 + rename）
   └─ ok("… (persisted in <path>)")
```

**B2. 协调者改一个标题**

```
② session_rename({sessionId, title})
   ├─ visibleTitleOf(title)                    → 预检：全是控制符/不可见标记就直接拒
   ├─ sessionController.rename({sessionId, title})
   │     └─ host: SessionTitleService.rename   → 归一化 + 截断 → 追加 session/title 事件（钉住）
   ├─ setTitle(sessionId, accepted.title)      → ① 只更新 title 一个字段
   └─ ok("Renamed … to: <被接受的标题> …pinned")
```

**为什么预检不代替 host**：host 才是权威（它归一化并按自己的字节预算截断，报告一律回它
**接受的**那个标题，而不是回显送进去的字符串）。预检只是不把一个必然被拒的标题送去
绕一圈，好让 `session/title-invalid` 不成为常见路径。**为什么单独写 `setTitle` 而不
复用 `observe`**：`observe` 是「我刚看到什么」的投影，会**替换**传入的每个字段——只带
title 的行会顺手抹掉 `parentId`/`kind`/`cwd`，把一个 fork 子会话静默重分类成顶层。
**为什么不能清空**：标题是日志里的一个事件，只能被新事件取代；能清空的只有私有备注
（`session_describe` 传空串）。

**C. 一次委托与它的回调**

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
   └─ prompt(me, queue, "[callback] …")             → 结果排进委托方自己的 inbox

   （任一步失败都不影响别的：目标读不到就保持 pending，通知投不出去就在 note 里写明）
```

## 6. 边界与已知取舍

- **记录不是保密边界**：`state.json` 对同一个本地用户可读。它是**归属边界**——除了这个包，没有别的东西读写它；备注也从不写进任何会话日志，所以侧栏、会话列表、轨迹视图和其他 agent 都看不到。
- **`session_compact` 改写目标历史**：可压缩段被替换成一个摘要节点，事务写进目标日志。除分叉或重来之外不可撤销。
- **记录不随会话删除**：① 按 session id 存，会话被删/归档后条目还在（`session_list` 只列活会话，所以这时看不到它；它下次再出现时备注与血缘原样还在）。不自动清理，避免误删仍在用的备注。
- **委托可能一直 `pending`**：如果那条提示始终没被目标接纳（它一直忙），或者目标的日志被压缩/清理掉了判定切点，回调就不会结案。推送是尽力而为，`session_delegations` 的 delegation ledger 才是真相，必要时用 `dismiss` 收尾。
- **只看得见本进程**：`sessionController` 是本进程的会话表。
- **子会话不由本模式驱动**：`origin:"subagent"` 的会话被 ownership fence 拦住，只有它的活父会话能驱动；分叉不受此限制。
- **未做**：冷会话压缩（需先唤醒）；`unknown` 状态的自动超时（目前只有人工 `dismiss`）。

## 7. 改动指南（哪一步要重启）

| 改什么 | 生效方式 |
|---|---|
| `lib/store.mjs` / `lib/tools.mjs` / `lib/loop.mjs` | 存盘即生效：preset 每次挂载都重新 import。想立刻验证用 `standingKeyFor` |
| `lib/ask-bridge.mjs` | 已被 import 的模块留在 Node 的 ESM 缓存里，所以要**让 host patch 行重新导入**：`patchReload: live` 下 touch 一下 `$DSH_HOME/cordis.patch.yml`，或重启 profile |
| `package.json`、preset 组合 | **要重启**（这些是启动时扫描/组合的东西） |

新增一个工具：写进 `lib/tools.mjs` 并 `ctx.tools.register(...)`，补 `package/test/tools.test.mjs`，把工具名加进 `agent.cordis.yml` 的 persona 清单与 `preset.yml` 描述。
新增一个持久字段：在 `lib/store.mjs` 的 `blankRecord`/`normalizeRecord`/对应 writer 三处同时加，`STATE_VERSION` 递增。
新增一种持久记录（像 `delegations` 那样）：同样的三处 + `parseState` 里补一段读取，并且**所有既有 writer 都必须 `{...state, …}` 地展开**——否则一次备注写入就会把这类新记录抹掉（`tools.test.mjs` 里的 `note write kept ledger` 就是钉这条的）。
改动回调判定规则（D6）：规则集中在 `readDelegationOutcome(events, baselineSeq)` 一个纯函数里，改它必须同时改测试里的脚本化日志。

## 8. 怎么验证

```sh
node package/test/tools.test.mjs                     # ② 与 ①：104 项
node package/lib/loop.test.mjs                       # `/loop` 分类、唤醒与幂等
node package/lib/ask-bridge.test.mjs                 # ④ 决策：83 项
node package/test/delegation-idempotency.test.mjs    # 回调幂等：15 项
dsh --profile web --dump-config | grep -A2 ask-bridge   # ④ 的 host 行应解析到一个真实文件（未挂则 grep 无输出）
```

preset 组合的正确性由 **`ctx.agentPresets.standingKeyFor('session-manager')`** 判定：它真实组合一遍插件子树（等同一次会话启动，只是不建 agent），能拒掉「行解析不到 / config 非法 / 某行从未激活 / 把服务发布进根 realm」四种失败。roster 的 `broken` 字段**不算**验证（它只做形状检查）。
