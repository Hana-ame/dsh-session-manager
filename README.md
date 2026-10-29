# DSH 会话管理器

一个 [DSH](https://github.com/deepseek-ai/deepseek-harness) 扩展包，一个包，四块功能：

| 模块 | 文件 | 作用 |
|---|---|---|
| ① 持久化 | `package/lib/store.mjs` | 每个会话的**关系信息**（父子、类型、目录、标题）与 **describe 私有备注**，落在 `<DSH_HOME>/session-manager/state.json`，重启不丢 |
| ② 管理工具 | `package/lib/tools.mjs` | 13 个会话管理工具：读写 ①、指挥本进程内的其他会话、**新建会话**、**委托带回音**、**撤销/改写未投递的排队消息** |
| `/loop` | `package/lib/loop.mjs` | 注册 `/loop` 斜杠命令：每 N 秒（默认 120）静默巡检 delegation ledger 与会话状态，有发现才唤醒本会话（preset 挂载，只读 ①） |
| ④ 提问桥 | `package/lib/ask-bridge.mjs` | 被委派会话调用 `ask_user_question` 时，**无条件**把问题转交回委托方等它决定，不代答、不超时放行（host 平面挂载，可不装） |

配套的 `preset/` 是「会话管理」agent preset：**这个模式下的会话只用来管理其他会话**。它不写代码、不改文件、不跑命令、不访问网络，只能观察、分叉、标注、压缩、指挥本进程内的其他会话，并在这些会话与用户之间协调信息。

> **想改这个包？先读 [`docs/DESIGN.md`](docs/DESIGN.md)**：设计意图、架构图、各层职责、关键决策的取舍（为什么一个包两个安置点、为什么 ① 是模块而不是 Cordis 服务、为什么 callback 是无状态轮询、为什么新建会话要判一次 `workspaceId`/`cwd`）、典型数据流、边界，以及「改哪一层要不要重启」。

> 0.3.0 起移除了 0.2 的会话画布（客户端半）：它没做好、可用性不高，已连同 host 路由与 profile 行一起删掉。会话管理工具与 preset 不受影响。

## 目录结构

```
package/                             # dsh-session-manager：唯一的包，各层都在里面
├── package.json                     # exports: "./tools" | "./store"
├── lib/
│   ├── store.mjs                    # ① 持久化存储（原子写 + stat 校验缓存）
│   ├── tools.mjs                    # ② 13 个管理工具（preset 挂载这一层）
│   ├── loop.mjs                     # `/loop` 命令 + 每会话定时巡检（preset 的 tool-loop 行挂载）
│   ├── loop.test.mjs                # `/loop` 的分类 / 唤醒 / 幂等测试
│   ├── ask-bridge.mjs               # ④ 被委派会话的提问桥（host 平面挂载）
│   └── ask-bridge.test.mjs          # ④ 决策的单元测试（假 ctx + 临时 DSH_HOME）
├── test/
│   ├── tools.test.mjs               # 工具层冒烟测试
│   └── delegation-idempotency.test.mjs
└── INSTALL.md                       # 安装、各层、以及踩过的坑

preset/                              # 挂 ② 的 agent preset
├── agent.cordis.yml                 # 组合；工具行按相对路径指回 package/
└── preset.yml                       # 显示名与描述

docs/DESIGN.md                       # 设计文档：理念、架构、各层职责、取舍与验证

install.sh                           # 一次装好：package + preset（④ 的 host 行由你加）
```

## 安装

```sh
./install.sh        # 尊重 $DSH_HOME，默认 ~/.dsh
```

它写两个位置，但只有**一份** package 拷贝：

- `$DSH_HOME/profiles/node_modules/dsh-session-manager/` —— 包本体（各层都在这里）；
- `$DSH_HOME/.agent-presets/session-manager/` —— preset，它的工具行用相对路径 `../../profiles/node_modules/dsh-session-manager/lib/tools.mjs` 指回上面那份包。

这两个位置都是被机制逼出来的，不是选择（详见 `package/INSTALL.md`）：preset 行的**裸包名只从 harness 安装目录解析**，相对路径才够得着已安装的包。包不再声明 `dsh.client`，所以**不需要** profile 行，也不提供任何 HTTP 路由。

④ 的提问桥不走 preset，而是 `$DSH_HOME/cordis.patch.yml` 里的一行 host patch（安装脚本会检查并打印该行）。原因见 [`package/INSTALL.md`](package/INSTALL.md)：被委派的 worker 通常跑的是别的 preset，preset 作用域的监听器根本看不到它的问题。

装完重启 profile。preset 发现本身每次都会重读 roots，所以改动 preset 不需要重启；改 `package.json` 则需要（删掉 0.2 profile 行的那次改动也要重启才彻底生效）。改 `ask-bridge.mjs` 后 touch 一下 `cordis.patch.yml` 即可让该行重新导入。

## 这个模式提供什么

| 工具 | 作用 |
|---|---|
| `session_list` | 列出**其他**会话（自己永远排除）：id、工作目录、标题、运行状态、血统（顶层 / 分叉 / 子会话）、私有备注、当前模型路由。默认只看当前工作目录（可显式传 `cwd`），`scope:"all"` 看全进程；支持 `runningOnly` 仅看运行中会话，`limit` 限制条数（默认 40）。**每次列出的血统都会写进 ①**，所以关系不会因为它描述的会话被归档而消失 |
| `session_read` | **只读**读某个会话最近的事件。`detail:"text"`（默认）只给 user/assistant 对话文本；`detail:"tools"` 再加工具调用、工具结果与失败信息；`detail:"all"` 再加 system/上下文消息、思考文本与标题变更。支持 `limit`（默认 8）、`maxChars`（每条事件上限，默认 1200）与 `totalChars`（整包字符预算，默认 12000）。**两个上限都可以自由放大**，需要完整交付时直接调大（如 `maxChars:30000`），返回头部会报出实际生效的上限与被切的方式。不唤醒、不写入，冷会话也能读 |
| `session_send` | 投递一条提示并唤醒目标：`queue`（默认，等它当前轮次结束）/ `steer`（在最近的 step 边界插入）。**`callback:true` = 委托带回音**：目标跑完那一轮后，结果自动投回你的会话 |
| `session_queue` | **只读**列出某个会话当前排队中的消息：顺序即投递顺序，每条带 `queued` / `steering` 标注，支持 `maxChars`（默认 400）。队列属于活着的 agent，冷会话没有队列；不投递、不取消、不放行。对这个会话有委托时，末尾附委托计数 |
| `session_queue_manage` | **写**侧补充：`action:"list"` 拿完整 `itemId`，再 `remove` 撤销 / `edit` 改写 / `clear` 清空**尚未投递**的排队消息（`clear` 需 `confirm:true`，支持 `dryRun`）。已投递的消息属于目标会话的历史，**不可撤销**，工具会明确报错而不是假装成功 |
| `session_delegations` | **只读**delegation ledger（持久化）：每条带 `callback` 的委托的状态、任务摘要与对方的答复；可按目标 `sessionId`、状态（`pending` / `done` / `failed` / `unknown`）过滤或设置 `limit`（默认 20），可用 `dismiss` 删掉已结案的行 |
| `session_stop` | 取消某活跃会话的当前轮次，保留其已排队消息 |
| `session_compact` | 要求某**活着且空闲**的会话立刻压缩自己的历史：在它自己的作用域里跑它的 `/compact`，可压缩段被替换成一个摘要节点 |
| `session_fork` | 在某个**已完成轮次**的边界上把会话分叉成独立副本，返回新的 session id |
| `session_create` | **新建**一个全新的顶层会话（**空历史**，不是分叉）：可指定 `preset` / `cwd` / `title` / `provider`+`model`，返回新 id。默认 preset = 调用者自己的 preset（读不到则 `standard`），默认 cwd = 调用者的工作目录 |
| `session_describe` | 给某个会话读 / 挂 / 清一条私有备注，写进 ① |
| `session_rename` | 读 / 改某个会话的**标题**（GUI 侧栏与 `session_list` 显示的那个）。写进目标会话日志，设一次即钉住 |
| `session_archive` | 归档 / 取消归档某个会话（走 workspace 注册表，与侧栏 Archive 同一个写入路径，运行中即时生效）：日志与记录都保留，只是从侧栏隐藏 |
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

- **关系、备注、delegation ledger 同库**：`session_list` 观测到的血统、`session_describe` 写的备注、`session_send(callback)` 记下的委托都进这一份文件，也是所有管理工具唯一读的那份记录。
- **读**：每次先 `stat` 文件（mtime+size），变了才重读，因此就算有第二个模块实例/进程在写也不会读到陈旧缓存。
- **写**：串行化 + 临时文件 `rename`，崩溃不会留下半截文件；**没有变化就不写**（重复 `session_list` 不会反复落盘，已结案的委托也不会被重复覆盖）。
- **升级**：老的 `descriptions.json` 只在 `state.json` 不存在时被一次性读入，原地升级不丢备注。
- **delegation ledger 上限**：委托记录保留最新的 200 条；用 `session_delegations({dismiss})` 手动删掉已结案的行。

## 读取会话消息

`session_read` 走的是 `sessionController.inspect(sessionId)`，它返回该会话的**完整事件日志**（活跃会话取内存快照，冷会话读持久化），所以三层细节都能给：

- `text`：`user/message`（只取 `source.kind === "user"` 的真实用户输入）+ `assistant/message` 的文本；
- `tools`：再加 `tool/call`（工具名 + 参数，参数截断到 `max(400, maxChars)` 字符）与 `tool/result`（结果文本，失败时带 `error.name: error.code`）；
- `all`：再加 `system/message`（插件注入的上下文）、assistant 的 `reasoning` 文本、`session/title` 变更。

读取**不会唤醒**目标会话（`inspect` 不 resolve Agent），也**不写任何东西**。默认返回最近 8 条匹配事件（`limit` 范围 1-40），单条事件默认上限 1200 字符（`maxChars` 范围 1-500000），整包默认 12000 字符预算（`totalChars` 范围 1-5000000）。

**大小由调用者决定**：`maxChars` 只管单条事件，`totalChars` 管整个回包，两者都自由可调。只放大 `maxChars` 时 `totalChars` 自动跟着变成 `maxChars × limit`，否则老的整包上限会把放大悄悄抵消；两个都显式给值时按你给的走。500000 / 5000000 只是防止手滑打出天文数字的保护顶，不是阅读限制。

返回头部（第一行）报出实际生效的上限与被切的方式，形如：

```
session session-abc | cwd /tmp/repo | 3 event(s) | detail=text | showing the last 2 matching event(s) | cap maxChars=1200, totalChars=12000 | 2 events clipped to 1200 characters each
```

末尾那一段只有被切过才出现，三种形态：
- `stopped at the N-character budget (M of N returned)` —— 整包预算用光，后面还有事件没取；
- `N events clipped to X characters each` —— 有条事件超过 `maxChars` 被截断（末尾带 `…`）；
- `reached the end of matching events (k of limit L)` —— 列表真的看完了，剩下的事件被 `detail` 过滤掉了。

所以「拿到半篇交付」这个情况现在能直接看出来：头部写着 `clipped` 或 `stopped at`，放大上限重读即可，不必猜。

## 排队消息（`session_queue`）

`session_send` 的 `queue` / `steer` 会把消息排进目标会话的 inbox，但 inbox 属于**活着的 agent**，只存在于实时控制流里。`session_queue` 因此这样做：

1. 打开 `sessionController.control(signal)` 这个 AsyncIterable——它的**第一帧是完整 baseline**，带 `queues: Record<SessionId, SessionQueuedItem[]>`；
2. 取走目标会话那一项（`placement` 是 `queued` / `steering` / `context`）；
3. **先 `abort()` 再 `break`** —— 直接 break 会等这个流自己取消，而那个取消信号正是我们手里的这一个，会死锁。

冷会话没有 inbox，工具会明确说明而不是假装「队列为空」。单条文本默认截断至 400 字符（可通过 `maxChars` 指定，范围 100-2000）。若有针对该会话的委托记录，末尾会附带委托统计。

`session_queue` 只读。要**撤销或改写**还没投递的消息，用 `session_queue_manage`：

1. 先 `action:"list"`（默认）拿每条 pending 消息的**完整 `itemId`**——`session_queue` 显示的是截短版；
2. 再 `action:"remove"`（撤销一条）/ `action:"edit"`（原地换文本，保留 `queued`/`steering` 位置）/ `action:"clear"`（清空，必须 `confirm:true`）；
3. `dryRun:true` 只校验并报告会改什么，不落任何改动。

**边界**：只有**尚未投递**的消息能动。一旦消息被接纳进目标当前轮次（或 steer 注入到 step 边界），它就已经离开 inbox、成为该会话的持久历史，**不可撤销、不可改写**——工具会返回明确错误，而不是静默成功。排队消息的 id 在被接纳时生成且不变，因此并发投递重排也不会认错条目。

## callback（`session_send({callback:true})` + `session_delegations`）

**问题**：`session_send` 把活派出去之后，委托方无从知道对方做完没有——只能反复 `session_read` 去猜。

**机制**：带 `callback:true` 时，② 在 ① 里记一条委托（`from` / `to` / 任务摘要 / `baselineSeq`），然后**自己盯着目标的持久日志**：

1. 目标收到的那条提示，就是 `baselineSeq` 之后的**第一条用户消息**；
2. 它的**第一个 `turn/end`** 就是这次委托的结局，两者之间的 `assistant/message` 文本就是答复；
3. 结案写回 ①（`done` / `failed` + 答复 + 原因），并把结果作为一条**排队消息**投回委托方会话。

被委托方**不需要任何配合**：它用哪个 preset 都行，因为盯着日志的是委托方这一侧的插件。所以这里**没有**、也不需要 `session_reply` 这类"让对方主动汇报"的工具——那要求对方也跑在会话管理模式里。

要点：

- **`baselineSeq` 之前的 `turn/end` 会被忽略**。`mode:"queue"` 时目标可能正在跑上一轮，那一轮结束跟你的委托无关；要等你的提示被接纳（日志里出现那条用户消息）之后，才是"你的那一轮"。
- **读的是持久日志，不是内存句柄**：进程重启后仍处于 `pending` 的委托会被继续盯到（preset 挂载时轮询器就起来了），不需要重新发起。
- **两条腿**：轮询（5 秒一次，且只有存在 `pending` 时才真正读盘）负责**推送**——结果自己回到你的会话；`session_delegations` 负责**对账**，它读之前先强制跑一遍检查，所以即使通知没送到（例如委托方会话已被删），delegation ledger 里也已经写好结果。支持按目标 `sessionId`、`status`（`pending` / `done` / `failed` / `unknown`）过滤，支持 `limit` 控制条数（默认 20），并可传入 `dismiss` 移除指定委托记录。
- **状态**：`pending`（还没跑完）/ `done`（`completed` 或 `max-tokens`）/ `failed`（`aborted` / `blocked` / 报错等，`note` 里带原因）/ `unknown`（没有确认到）。
- **不会重复通知**：委托一旦结案就不再重新判定（只有 `pending` 的记录才能被结案），所以不会因为下一轮又结束而再投一次。
- 回调通知本身是普通的 `queue` 消息，**不会打断**委托方正在跑的轮次；它会看到一条以 `[callback]` 开头的用户消息。

## 触发压缩（`session_compact`）

`/compact` 命令（`@deepseek-ai/dsh-command-compact`）在**每个 preset 自己的 compaction realm 里**注册，所以它执行时的 `ctx.compaction` 就是**目标会话自己的**引擎。于是本工具只做一件事：

```js
await ctx.commands.execute({ id: sessionId }, '/compact', [], signal)
```

`CommandRuntime.execute` 的第一个参数就是一个**裸 agent（只有 id）**，作用域注册按 agent 解析——这正是「从外部替某个会话执行它自己的命令」的路径。

- 目标**必须是活着且空闲的**：正在跑一轮、正在压缩、或冷会话（没有 agent 就没有作用域注册）都会明确报出原因。
- 目标 preset 没有组合压缩能力（例如 `minimal`）时没有 `/compact` 可跑。
- **副作用**：它改写目标会话的历史（可压缩段 → 摘要节点），并往目标日志里写 `command/run`、`command/done` 与压缩事务事件。汇报时必须说清。

## 会话标题（`session_rename`）

`session_rename({ sessionId, title? })`：

- 省略 `title` → 读当前标题；传 `title` → 改标题。改的是**标题**：GUI 侧栏、`session_list` 和其他会话都能看见的那个短标签。
- 走底层 `sessionController.rename()`，host 在目标会话自己的日志里追加一个 `session/title` 事件（`source.kind === "user"`）。**所以标题与私有备注完全独立**：备注只进 ①，标题进会话日志。
- **设一次就钉住**：host 侧正在进行的自动标题生成会被作废，之后的用户消息也不再排新的生成——除非 host 主动调用它自己的 refresh。反过来说，自动标题一旦被人改过，就由人说了算。
- **host 是权威**：它会剥掉控制符与 ANSI 转义、合并连续空白、按自己的字节预算截断（默认 80 字节）。工具的回话报的是**被接受的**标题，不是送进去的字符串——中文标题很容易因为字节预算被截短。
- 空串、纯空白、纯不可见字符会被直接拒绝：标题只能**改**不能**清空**（日志里的事件只能被新事件取代）。要取消标记用 `session_describe` 传空串清备注。
- **副作用**：目标会话若是冷会话会被唤醒（resume）一个；host 未挂 `session-title` 服务时返回 `gateway/internal`。

## 私有备注（`session_describe`）

`session_describe({ sessionId, description? })`：

- 给 `description` → 设置备注（trim 后截断到 200 字符）；给空串 → 清除；整个字段省略 → 读当前备注。若目标 `sessionId` 当前在进程中未找到，备注仍会被持久化存储，并附带 Warning 提示。
- 它**不是会话标题**：不写进任何会话日志，所以侧栏、会话列表、轨迹视图、其他 agent 都看不到。只有本包的 `session_list` 会显示 `note:`。
- 清除备注**不会**清掉这个会话的血统记录——两者在同一条记录里但互不覆盖。
- **它不是保密边界**：文件就在 DSH home 里，任何进程都能打开。它是**归属边界**——除了这个包，没有别的东西读写它。

## 中途切换模型

`session_models()` 列出 `sessionController.modelCatalog()` 的内容：部署默认、可路由 provider、按 provider 分组的 model（带各自的 reasoning effort 与默认 effort），以及**发现失败**的 provider（没有凭据之类）。catalog 只是提示，不控制路由。

`session_model({ sessionId, provider?, model?, reasoningEffort? })`：

- **只给 sessionId = 读**。走的是 `modelSelection` 这个 session projection（`wire.view` 是 `{ lastUsed, next }`，随 `session_list` 一起下发），**冷会话也能读，且不会唤醒它**；该会话没有 projection 缓存时，插件自己 fold 日志（最后一条 `model/selection` 是 pending，最后一条 `request/header` 是实际用过的路由）作为回退。
- **给 provider + model = 切换**，走 `sessionController.selectModel`。因为是逐请求生效，**运行中的会话在下一个 step 就会用新模型**。只给一半会被拒绝并提示。
- **两个副作用必须知道**：`selectModel` 还会 `agentDefaultModel.saveSelection(...)`（把这次选择**同时存成部署默认**，影响之后新建的会话），并且会先 `resolveAgent`（**冷会话被唤醒**）。

## 新建会话 vs 分叉（`session_create` / `session_fork`）

| | `session_create` | `session_fork` |
|---|---|---|
| 历史 | **空** | 继承到切点为止 |
| preset | 任意指定（默认跟调用者） | 继承源会话 |
| cwd | 任意指定（默认跟调用者） | 继承源会话 |
| 用途 | 派一份**全新**的活、换个 preset、另开一个工作目录 | 在**同一份上下文**上分两条路对比 |

`session_create({preset?, cwd?, title?, provider?, model?, reasoningEffort?})` → 返回新 session id。

- **preset 默认值**：先取调用者会话记录里的 `agentPreset`，取不到才用 `standard`。所以「会话管理」会话默认会造出**另一个「会话管理」会话**；要派编码活就显式传 `preset:"standard"` 或 `"ptc"`。
- **cwd 与工作区**：底层 `sessionController.create` 只接受 **`workspaceId` 或 `cwd` 二选一**（同时给直接 `gateway/bad-request`），而且**只有 `workspaceId` 那条路会把会话挂进工作区**。所以工具先查一次 `workspaceRegistry.resolveByPath(cwd)`：
  - cwd 正好是**已登记工作区的根目录** → 传 `workspaceId`，会话挂进该工作区（出现在侧栏的工作区里）；
  - 否则 → 原样传 `cwd`，会话**不**挂任何工作区。
- **title** 调一次 `rename`，**provider+model** 调一次 `selectModel`：这个新建的会话本来就有一个 idle 的活 agent，这两个调用会让它再醒一下；`selectModel` 还会把该模型顺带存成**部署默认**（与 `session_model` 同一个副作用）。任一步失败都**不会**丢掉已创建的 session——结果里会写「title NOT set / model NOT set」，id 照常返回。
- 新会话会立刻写进 ①（顶层、cwd、标题），所以下一次 `session_list` 之前就已经记得它。

## 分叉语义

`session_fork({ sessionId, atSeq?, title? })`：

- **切点**：只在已完成轮次（`turn/end`）的边界上切。默认取最后一个；给了 `atSeq` 就取第一个 `seq >= atSeq` 的 `turn/end`，再把切点向后推到下一个 `turn/start`。
- **继承**：源会话的 agent preset 与工作目录（并挂到源会话所在 workspace）。
- **独立**：副本有自己的日志和 agent，`session_read` / `session_send` / `session_stop` 对它全部有效。
- **标题**：可显式指定 `title`（截断至 60 字符）；不给 `title` 时自动改名为 `"<源标题> · fork"`（源会话无标题时为 `"fork"`）。
- **注意**：切点之后源会话产生的内容**不在副本里**；副本站起来用的是**当前默认模型**。

## 测试

```sh
node package/lib/ask-bridge.test.mjs                 # ④ 决策 83 项
node package/lib/loop.test.mjs                       # `/loop` 巡检分类与唤醒
node package/test/tools.test.mjs                     # 工具层 104 项
node package/test/delegation-idempotency.test.mjs    # 回调幂等 15 项
```

工具层用假 Cordis ctx + 临时 `DSH_HOME` 跑真实插件文件，覆盖：① 的迁移 / 落盘 / 不再重复落盘 / 清备注保留血统，`session_list` 的血统标注、备注、模型路由与观测落库，`session_read` 三档 detail，模型目录的渲染与失败项，模型**读取**（优先 projection、回退 fold、不 resume）与**切换**（字段完整、半对参数被拒、副作用披露），发送/自投递/空文本拦截、取消、分叉与自动命名，排队消息读取（顺序、`placement`、截断、空队列、冷会话、读完即释放控制流、只读性），压缩（替目标跑 `/compact`、传出真实信号与空附件、拒绝结果、无压缩 preset、冷会话、自压缩拦截），以及**callback**（记账、任务摘要、无 callback 不记账、无调用者身份被拒、watcher 定时器注册、结案带答复、结果投回委托方、已结案不重复通知、失败轮次带原因、接纳之前的 `turn/end` 不算数、状态过滤、`session_queue` 的委托标记、`dismiss`）与**新建会话**（返回 id、默认 preset 与 cwd、`workspaceId`/`cwd` 互斥分流、显式 preset、`title` 与 `selectModel` 调用、继承调用者 preset、半个模型对被拒、未知 preset 的引导、title 失败不丢 session、写入 ①）。

## 重要边界

- **只看得见本进程**：`sessionController` 是本 DSH 进程内的会话表，别的 dsh 进程/服务上的会话看不到、管不了。
- **子会话不由本模式驱动**：`origin:"subagent"` 的会话被 ownership fence 拦住，只能由它的活父会话走 subagent 通道；**分叉不受此限制**。
- **`session_send` 等于用户消息**：写进去的就是目标会话日志里的用户消息，目标会真的开始干活。
- **`session_compact` 改写目标历史**：它替换目标会话的上下文并把事务写进它的日志；压缩不可撤销（除了分叉或重来）。
- **排队消息只能趁没投递时改**：`session_queue_manage` 动的永远是 inbox 里 pending 的条目；已经投递的消息是目标会话的日志/历史，只能靠分叉或重来。
- **回调是"盯日志"，不是对方的配合**：`callback` 只要求目标把那一轮跑完并在日志里留下痕迹。如果那条提示**始终没被接纳**（目标一直忙、或它的日志被压缩/清理掉了切点），委托会一直是 `pending`；此时以 `session_delegations` 的 delegation ledger 和 `session_queue` 的队列为准，必要时 `dismiss` 收尾。
- **没有视图**：0.3.0 移除了会话画布，这个包只提供工具，不向浏览器下发任何东西，也没有 HTTP 路由。
- **被委派的会话不再会被一个提问永久挂住**：④ 的 host 行接管「提问者是任何一条委托的 target」的情形——问题、选项与推荐项按 `sessionController.prompt` 排队投进**委托方**的会话，worker 就地等；委托方用一条普通 `session_send` 回话，worker 那个卡住的工具调用就带着答复解锁。**不挂这行就恢复原行为**（`ask_user_question` 无超时，worker 可能一直等下去）；**挂了就等**：没有 grace、没有默认答案，`timeoutMs` 默认 `0` = 等到委托方决定为止，到期或投递失败都是让工具调用报错而不是替它选一个。转交与答复记在委托行的 `askLog`（`session_delegations` 里是 `asked:` 行），任务结算不会清掉它。**前台人类提问完全不受影响**——不是任何委托 target 的会话原样走自己的浏览器。
- **`/loop` 是会话内的巡检，不是后台守护**：`loop.mjs` 注册一个 `/loop` 斜杠命令，由**跑该 preset 的会话自己**每 N 秒（默认 120 s）读一次 delegation ledger 与会话表；只有发现新结算委托或疑似卡住会话时才用一条 `[LOOP patrol]` 排队消息唤醒自己，无事则完全静默。定时器**只在内存里**，进程重启后需要重新 `/loop`（delegation ledger 本身是持久的，不会丢）。它只建议 agent dismiss 已经汇报过的已结算委托，绝不自动派活、重投或 `session_stop`。
- **记录不随会话删除**：① 按 session id 存；会话被删或归档后条目仍在（不清理，避免误删仍在用的备注）。它下次再出现时，备注与血缘原样还在。

## 出处

从一台运行中的 DSH 上导出并演进：preset 已通过 `ctx.agentPresets.standingKeyFor()` **真实挂载校验**（组合能导入、config 合法、每行都能激活、没有把服务发布进根 realm）；工具层测试全绿。
