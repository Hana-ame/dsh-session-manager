# DSH 会话管理器

一个 [DSH](https://github.com/deepseek-ai/deepseek-harness) 扩展包，三层一体：

| 层 | 文件 | 作用 |
|---|---|---|
| ① 持久化 | `package/lib/store.mjs` | 每个会话的**关系信息**（父子、类型、目录、标题）与 **describe 私有备注**，落在 `<DSH_HOME>/session-manager/state.json`，重启不丢 |
| ② 管理工具 | `package/lib/tools.mjs` | 11 个会话管理工具：读写 ①、指挥本进程内的其他会话、**委托带回音** |
| ③ 画布 | `package/lib/client.js` | 把这些持久化数据画成关系图（当前工作区，观察窗口） |

配套的 `preset/` 是「会话管理」agent preset：**这个模式下的会话只用来管理其他会话**。它不写代码、不改文件、不跑命令、不访问网络，只能观察、分叉、标注、压缩、指挥本进程内的其他会话，并在这些会话与用户之间协调信息。

> **想改这个包？先读 [`docs/DESIGN.md`](docs/DESIGN.md)**：设计意图、架构图、各层职责、八个关键决策的取舍（为什么一个包两个挂载点、为什么 ① 是模块而不是 Cordis 服务、为什么画布走同源路由、为什么委托回调是无状态轮询）、典型数据流、边界，以及「改哪一层要不要重启」。

## 目录结构

```
package/                             # @local/dsh-session-manager：唯一的包，三层都在里面
├── package.json                     # exports: "." | "./client" | "./tools" | "./store"
├── lib/
│   ├── store.mjs                    # ① 持久化存储（原子写 + stat 校验缓存）
│   ├── tools.mjs                    # ② 11 个管理工具（preset 挂载这一层）
│   ├── index.js                     # host 半：提供 GET /session-manager/state，把 ① 送给 ③
│   └── client.js                    # ③ 画布（手写 classic-script bundle）
├── test/
│   ├── tools.test.mjs               # 工具层冒烟测试（假 ctx + 临时 DSH_HOME）
│   └── scope.test.mjs               # 画布「只画当前工作区」的纯函数测试
└── INSTALL.md                       # 安装、三层、以及踩过的坑

preset/                              # 挂 ② 的 agent preset
├── agent.cordis.yml                 # 组合；工具行按相对路径指回 package/
└── preset.yml                       # 显示名与描述

docs/DESIGN.md                       # 设计文档：理念、架构、各层职责、取舍与验证

install.sh                           # 一次装好：package + preset + profile 行
```

## 安装

```sh
./install.sh        # 尊重 $DSH_HOME，默认 ~/.dsh
```

它写两个位置，但只有**一份** package 拷贝：

- `$DSH_HOME/profiles/node_modules/@local/dsh-session-manager/` —— 包本体（三层都在这里）；
- `$DSH_HOME/.agent-presets/session-manager/` —— preset，它的工具行用相对路径 `../../profiles/node_modules/@local/dsh-session-manager/lib/tools.mjs` 指回上面那份包；
- `$DSH_HOME/profiles/web/cordis.patch.yml` —— 一行 Loader entry，客户端半（③）靠它才会被下发。

两个位置都是被机制逼出来的，不是选择（详见 `package/INSTALL.md`）：preset 行的**裸包名只从 harness 安装目录解析**，相对路径才够得着已安装的包；而客户端半只有 host Loader 的 entry 才会被扫描，preset 子树永远不被扫描。

装完重启 profile。preset 发现本身每次都会重读 roots，所以改动 preset 不需要重启；改 `package.json` / profile 行则需要。

## 这个模式提供什么

| 工具 | 作用 |
|---|---|
| `session_list` | 列出**其他**会话（自己永远排除）：id、工作目录、标题、运行状态、血统（顶层 / 分叉 / 子会话）、私有备注、当前模型路由。默认只看当前工作目录，`scope:"all"` 看全进程。**每次列出的血统都会写进 ①**，所以关系不会因为它描述的会话被归档而消失 |
| `session_read` | **只读**读某个会话最近的事件。`detail:"text"`（默认）只给 user/assistant 对话文本；`detail:"tools"` 再加工具调用、工具结果与失败信息；`detail:"all"` 再加 system/上下文消息、思考文本与标题变更。不唤醒、不写入，冷会话也能读 |
| `session_send` | 投递一条提示并唤醒目标：`queue`（默认，等它当前轮次结束）/ `steer`（在最近的 step 边界插入）。**`callback:true` = 委托带回音**：目标跑完那一轮后，结果自动投回你的会话 |
| `session_queue` | **只读**列出某个会话当前排队中的消息：顺序即投递顺序，每条带 `queued` / `steering` 标注。队列属于活着的 agent，冷会话没有队列；不投递、不取消、不放行。对这个会话有委托时，末尾附委托计数 |
| `session_delegations` | **只读**委托账本（持久化）：每条带 `callback` 的委托的状态、任务摘要与对方的答复；`pending` / `done` / `failed` / `unknown`，可用 `dismiss` 删掉已结案的行 |
| `session_stop` | 取消某活跃会话的当前轮次，保留其已排队消息 |
| `session_compact` | 要求某**活着且空闲**的会话立刻压缩自己的历史：在它自己的作用域里跑它的 `/compact`，可压缩段被替换成一个摘要节点 |
| `session_fork` | 在某个**已完成轮次**的边界上把会话分叉成独立副本，返回新的 session id |
| `session_describe` | 给某个会话读 / 挂 / 清一条私有备注，写进 ① |
| `session_models` | 列出当前可路由的 provider / model 与各自支持的 reasoning effort |
| `session_model` | 读某个会话的模型路由（`next` / `lastUsed`），或**中途切换**它 |

组合里还有 `persona`（协调者人格）、`ask_user_question`、`todo_write`、goal 与 compaction。

**刻意不包含**：shell（bash/pwsh）、文件与搜索、后台任务、skills、plan mode、web、present、子代理/工作流。所以这个 agent 碰不到机器和网络。

## ① 持久化存储

`<DSH_HOME>/session-manager/state.json`：

```json
{
  "version": 3,
  "byId": {
    "<sessionId>": {
      "description": "私有备注（≤200 字符，空串表示已清除）",
      "updatedAt": 0,
      "parentId": "父会话 id 或 null",
      "kind": "top-level | fork | subagent",
      "cwd": "/abs/path 或 null",
      "title": "标题或 null",
      "firstSeenAt": 0
    }
  },
  "delegations": [
    {
      "id": "dlg-…",
      "from": "委托方 session id",
      "to": "目标 session id",
      "task": "交付出去的任务文本（≤200 字符）",
      "mode": "queue | steer",
      "status": "pending | done | failed | unknown",
      "createdAt": 0,
      "baselineSeq": 0,
      "settledAt": 0,
      "reply": "对方的答复（≤1200 字符）",
      "note": "结案原因或投递失败的说明"
    }
  ]
}
```

- **关系、备注、委托账本同库**：`session_list` 观测到的血统、`session_describe` 写的备注、`session_send(callback)` 记下的委托都进这一份文件，画布（③）读的也是它——所以「工具」和「画布」是同一份记录的两个视图。
- **读**：每次先 `stat` 文件（mtime+size），变了才重读，因此就算有第二个模块实例/进程在写也不会读到陈旧缓存。
- **写**：串行化 + 临时文件 `rename`，崩溃不会留下半截文件；**没有变化就不写**（重复 `session_list` 不会反复落盘，已结案的委托也不会被重复覆盖）。
- **升级**：老的 `descriptions.json` 只在 `state.json` 不存在时被一次性读入，原地升级不丢备注。
- **账本上限**：委托记录保留最新的 200 条；用 `session_delegations({dismiss})` 手动删掉已结案的行。

## 读取会话消息

`session_read` 走的是 `sessionController.inspect(sessionId)`，它返回该会话的**完整事件日志**（活跃会话取内存快照，冷会话读持久化），所以三层细节都能给：

- `text`：`user/message`（只取 `source.kind === "user"` 的真实用户输入）+ `assistant/message` 的文本；
- `tools`：再加 `tool/call`（工具名 + 参数，参数截断到 400 字符）与 `tool/result`（结果文本，失败时带 `error.name: error.code`）；
- `all`：再加 `system/message`（插件注入的上下文）、assistant 的 `reasoning` 文本、`session/title` 变更。

读取**不会唤醒**目标会话（`inspect` 不 resolve Agent），也**不写任何东西**。

## 排队消息（`session_queue`）

`session_send` 的 `queue` / `steer` 会把消息排进目标会话的 inbox，但 inbox 属于**活着的 agent**，只存在于实时控制流里。`session_queue` 因此这样做：

1. 打开 `sessionController.control(signal)` 这个 AsyncIterable——它的**第一帧是完整 baseline**，带 `queues: Record<SessionId, SessionQueuedItem[]>`；
2. 取走目标会话那一项（`placement` 是 `queued` / `steering` / `context`）；
3. **先 `abort()` 再 `break`** —— 直接 break 会等这个流自己取消，而那个取消信号正是我们手里的这一个，会死锁。

冷会话没有 inbox，工具会明确说明而不是假装「队列为空」。

## 委托回调（`session_send({callback:true})` + `session_delegations`）

**问题**：`session_send` 把活派出去之后，委托方无从知道对方做完没有——只能反复 `session_read` 去猜。

**机制**：带 `callback:true` 时，② 在 ① 里记一条委托（`from` / `to` / 任务摘要 / `baselineSeq`），然后**自己盯着目标的持久日志**：

1. 目标收到的那条提示，就是 `baselineSeq` 之后的**第一条用户消息**；
2. 它的**第一个 `turn/end`** 就是这次委托的结局，两者之间的 `assistant/message` 文本就是答复；
3. 结案写回 ①（`done` / `failed` + 答复 + 原因），并把结果作为一条**排队消息**投回委托方会话。

被委托方**不需要任何配合**：它用哪个 preset 都行，因为盯着日志的是委托方这一侧的插件。所以这里**没有**、也不需要 `session_reply` 这类"让对方主动汇报"的工具——那要求对方也跑在会话管理模式里。

要点：

- **`baselineSeq` 之前的 `turn/end` 会被忽略**。`mode:"queue"` 时目标可能正在跑上一轮，那一轮结束跟你的委托无关；要等你的提示被接纳（日志里出现那条用户消息）之后，才是"你的那一轮"。
- **读的是持久日志，不是内存句柄**：进程重启后仍处于 `pending` 的委托会被继续盯到（preset 挂载时轮询器就起来了），不需要重新发起。
- **两条腿**：轮询（5 秒一次，且只有存在 `pending` 时才真正读盘）负责**推送**——结果自己回到你的会话；`session_delegations` 负责**对账**，它读之前先强制跑一遍检查，所以即使通知没送到（例如委托方会话已被删），账本里也已经写好结果。
- **状态**：`pending`（还没跑完）/ `done`（`completed` 或 `max-tokens`）/ `failed`（`aborted` / `blocked` / 报错等，`note` 里带原因）/ `unknown`（没有确认到）。
- **不会重复通知**：委托一旦结案就不再重新判定（只有 `pending` 的记录才能被结案），所以不会因为下一轮又结束而再投一次。
- 回调通知本身是普通的 `queue` 消息，**不会打断**委托方正在跑的轮次；它会看到一条以 `[委托回调]` 开头的用户消息。

## 触发压缩（`session_compact`）

`/compact` 命令（`@deepseek-ai/dsh-command-compact`）在**每个 preset 自己的 compaction realm 里**注册，所以它执行时的 `ctx.compaction` 就是**目标会话自己的**引擎。于是本工具只做一件事：

```js
await ctx.commands.execute({ id: sessionId }, '/compact', [], signal)
```

`CommandRuntime.execute` 的第一个参数就是一个**裸 agent（只有 id）**，作用域注册按 agent 解析——这正是「从外部替某个会话执行它自己的命令」的路径。

- 目标**必须是活着且空闲的**：正在跑一轮、正在压缩、或冷会话（没有 agent 就没有作用域注册）都会明确报出原因。
- 目标 preset 没有组合压缩能力（例如 `minimal`）时没有 `/compact` 可跑。
- **副作用**：它改写目标会话的历史（可压缩段 → 摘要节点），并往目标日志里写 `command/run`、`command/done` 与压缩事务事件。汇报时必须说清。

## 私有备注（`session_describe`）

`session_describe({ sessionId, description? })`：

- 给 `description` → 设置备注（trim 后截断到 200 字符）；给空串 → 清除；整个字段省略 → 读当前备注。
- 它**不是会话标题**：不写进任何会话日志，所以侧栏、会话列表、轨迹视图、其他 agent 都看不到。只有本包的 `session_list` 会显示 `note:`，画布（读同一份 ①）会画在节点里与详情里。
- 清除备注**不会**清掉这个会话的血统记录——两者在同一条记录里但互不覆盖。
- **它不是保密边界**：文件就在 DSH home 里，任何进程都能打开。它是**归属边界**——除了这个包，没有别的东西读写它。

## 中途切换模型

`session_models()` 列出 `sessionController.modelCatalog()` 的内容：部署默认、可路由 provider、按 provider 分组的 model（带各自的 reasoning effort 与默认 effort），以及**发现失败**的 provider（没有凭据之类）。catalog 只是提示，不控制路由。

`session_model({ sessionId, provider?, model?, reasoningEffort? })`：

- **只给 sessionId = 读**。走的是 `modelSelection` 这个 session projection（`wire.view` 是 `{ lastUsed, next }`，随 `session_list` 一起下发），**冷会话也能读，且不会唤醒它**；该会话没有 projection 缓存时，插件自己 fold 日志（最后一条 `model/selection` 是 pending，最后一条 `request/header` 是实际用过的路由）作为回退。
- **给 provider + model = 切换**，走 `sessionController.selectModel`。因为是逐请求生效，**运行中的会话在下一个 step 就会用新模型**。只给一半会被拒绝并提示。
- **两个副作用必须知道**：`selectModel` 还会 `agentDefaultModel.saveSelection(...)`（把这次选择**同时存成部署默认**，影响之后新建的会话），并且会先 `resolveAgent`（**冷会话被唤醒**）。

## 分叉语义

`session_fork({ sessionId, atSeq?, title? })`：

- **切点**：只在已完成轮次（`turn/end`）的边界上切。默认取最后一个；给了 `atSeq` 就取第一个 `seq >= atSeq` 的 `turn/end`，再把切点向后推到下一个 `turn/start`。
- **继承**：源会话的 agent preset 与工作目录（并挂到源会话所在 workspace）。
- **独立**：副本有自己的日志和 agent，`session_read` / `session_send` / `session_stop` 对它全部有效。
- **标题**：不给 `title` 时自动改名为 `"<源标题> · fork"`。
- **注意**：切点之后源会话产生的内容**不在副本里**；副本站起来用的是**当前默认模型**。

## 使用画布（③）

画布是同一个包里的客户端半，占 `$DSH_HOME/profiles/web/cordis.patch.yml` 的一行 Loader entry，进程重启后依然在；删掉那一行即彻底撤下。

- **只画当前工作区**：以 `shell.overlay` 标准 prop `useWorkspaces` 的 Workspace 投影为准，用与侧栏完全相同的推导（`items.find(item => item.sessionIds.includes(current))`）选出当前会话所属工作区；保留「该工作区登记的会话 ∪ cwd 位于工作区路径之下的会话（子会话常起在子目录）∪ 已保留会话的全部后代」。当前会话本身是子会话/分叉时，沿 `parentSessionId` 上溯。**找不到工作区时画 0 个节点**（并在画布上写明原因），不会退回「全部工作区」。
- **读的是持久化数据**：图 = `session.list`（活会话）∪ ① 里还记着、但已经不在活列表里的会话（归档/删除过的，画成虚线灰底的 `remembered` 节点）。每个节点上的 `✎` 就是它的 describe 备注，详情栏里也有。
- **两条数据通路**：`remote.session.list` 走已有 Remote 命名空间；① 走本包 host 半提供的 `GET /session-manager/state`。两条路各自失败互不拖累：store 读不到时画布退化成「只有活会话」，并在标题栏写明原因。
  > 那条路由**自身不鉴权**（不像页面那样要求凭据），但服务只绑在 `127.0.0.1`，返回的内容与 `<DSH_HOME>/session-manager/state.json` 完全一致——同一个本地用户本来就能读那个文件，所以它没有扩大暴露面。**它不是保密边界**。
- 交互：拖拽平移、`−`/`+` 缩放、「适应」重排、点节点看详情；每 4 秒刷新。

> 客户端半必须声明 `inject: ['remote', 'remote.session', 'slots']`。`remote.session` 是 `ctx.remote.$mount` 挂上来的**独立 Cordis 服务**，不是 `remote` 服务的普通属性；不声明就访问会被 Cordis guard 拒绝：`cannot get property "remote.session" without inject`（面板报 `error:` 且 0 节点时先查这里）。
>
> bundle 的 envelope id 必须等于包名（`@local/dsh-session-manager`），客户端模块系统靠它把 factory 对上 graph row。
>
> 改完 `lib/client.js` **不必重启**：profile 里的 `client-hmr` 每 500ms 轮询 bundle 的 mtime/size，一变就经 SSE 推给页面热替换。

## 测试

```sh
node package/test/tools.test.mjs     # 工具层 77 项
node package/test/scope.test.mjs     # 画布作用域 18 项
```

工具层用假 Cordis ctx + 临时 `DSH_HOME` 跑真实插件文件，覆盖：① 的迁移 / 落盘 / 不再重复落盘 / 清备注保留血统，`session_list` 的血统标注、备注、模型路由与观测落库，`session_read` 三档 detail，模型目录的渲染与失败项，模型**读取**（优先 projection、回退 fold、不 resume）与**切换**（字段完整、半对参数被拒、副作用披露），发送/自投递/空文本拦截、取消、分叉与自动命名，排队消息读取（顺序、`placement`、截断、空队列、冷会话、读完即释放控制流、只读性），压缩（替目标跑 `/compact`、传出真实信号与空附件、拒绝结果、无压缩 preset、冷会话、自压缩拦截），以及**委托回调**（记账、任务摘要、无 callback 不记账、无调用者身份被拒、watcher 定时器注册、结案带答复、结果投回委托方、已结案不重复通知、失败轮次带原因、接纳之前的 `turn/end` 不算数、状态过滤、`session_queue` 的委托标记、`dismiss`）。

作用域测试用 `new Function` 从**真实 bundle** 里切出作用域纯函数再断言，所以断言跑的是出货文件本身；helper 的注释标记一旦移动，测试会直接报错而不是静默通过。

## 重要边界

- **只看得见本进程**：`sessionController` 是本 DSH 进程内的会话表，别的 dsh 进程/服务上的会话看不到、管不了。
- **子会话不由本模式驱动**：`origin:"subagent"` 的会话被 ownership fence 拦住，只能由它的活父会话走 subagent 通道；**分叉不受此限制**。
- **`session_send` 等于用户消息**：写进去的就是目标会话日志里的用户消息，目标会真的开始干活。
- **`session_compact` 改写目标历史**：它替换目标会话的上下文并把事务写进它的日志；压缩不可撤销（除了分叉或重来）。
- **回调是"盯日志"，不是对方的配合**：`callback` 只要求目标把那一轮跑完并在日志里留下痕迹。如果那条提示**始终没被接纳**（目标一直忙、或它的日志被压缩/清理掉了切点），委托会一直是 `pending`；此时以 `session_delegations` 的账本和 `session_queue` 的队列为准，必要时 `dismiss` 收尾。
- **画布必须占一行 Loader entry**：客户端半放在 preset 里不会被扫描到。**画布只显示当前工作区**，进程内其他工作区的会话不在图上（刻意的）。
- **记录不随会话删除**：① 按 session id 存；会话被删或归档后条目仍在（不清理，避免误删仍在用的备注），画布把它们画成 `remembered`。

## 出处

从一台运行中的 DSH 上导出并演进：preset 已通过 `ctx.agentPresets.standingKeyFor()` **真实挂载校验**（组合能导入、config 合法、每行都能激活、没有把服务发布进根 realm）；包的手写 bundle 已用假 `window.__ModuleLoader__` 验证 envelope、`inject` 与两个 slot 注册；工具层与作用域测试全绿。
