# DSH 会话管理模式

一个 [DSH](https://github.com/deepseek-ai/deepseek-harness)（DeepSeek Harness）agent preset：**这个模式下的会话只用来管理其他会话**。它不写代码、不改文件、不跑命令、不访问网络，只能观察、分叉、标注、指挥本 DSH 进程内的其他会话，并在这些会话与用户之间协调信息。

配套还有一个会话关系画布（Session Canvas）：把进程内所有会话画成节点，按工作目录分组，用连线表示父子/分叉关系。

## 目录结构

```
preset/                              # 可直接使用的 agent preset（拷进 DSH 用户 preset 根目录即可）
├── agent.cordis.yml                 # Cordis 组合
├── preset.yml                       # 显示名与描述
└── tools/
    ├── session-control.mjs          # 8 个会话管理工具的持久实现
    └── session-control.test.mjs     # 冒烟测试（假 ctx + 临时 DSH_HOME，不碰真实状态）

plugins/session-canvas/              # 动态 Cordis 包源码（不是 ES module，见下）
├── host.js                          # code.host：注册 sessions-graph RPC
└── client.js                        # code.client：画布面板 + 侧栏按钮
```

## 安装 preset

```sh
cp -r preset "$HOME/.dsh/.agent-presets/session-manager"
```

DSH 的 preset 发现每次都会重读 roots，所以**不需要重启**：新建会话时在模式选择里就能看到「会话管理」。已产出内容的会话不能换 preset。

## 这个模式提供什么

| 工具 | 作用 |
|---|---|
| `session_list` | 列出**其他**会话（自己永远排除）：id、工作目录、标题、运行状态、血统（顶层 / 某个会话的分叉 / 子会话），以及本模式给它挂的私有备注。默认只看当前工作目录，`scope:"all"` 看全进程 |
| `session_read` | **只读**读某个会话最近的事件。`detail:"text"`（默认）只给 user/assistant 对话文本；`detail:"tools"` 再加工具调用、工具结果与失败信息；`detail:"all"` 再加 system/上下文消息、思考文本与标题变更。不唤醒、不写入，冷会话也能读 |
| `session_send` | 投递一条提示并唤醒目标：`queue`（默认，等它当前轮次结束）/ `steer`（在最近的 step 边界插入） |
| `session_stop` | 取消某活跃会话的当前轮次，保留其已排队消息 |
| `session_fork` | 在某个**已完成轮次**的边界上把会话分叉成独立副本，返回新的 session id |
| `session_describe` | 给某个会话挂 / 读 / 清一条**只有本 preset 看得到**的私有备注 |
| `session_models` | 列出当前可路由的 provider / model 与各自支持的 reasoning effort |
| `session_model` | 读某个会话的模型路由（`next` / `lastUsed`），或**中途切换**它 |

组合里还有 `persona`（协调者人格）、`ask_user_question`、`todo_write`、goal 与 compaction。

**刻意不包含**：shell（bash/pwsh）、文件与搜索、后台任务、skills、plan mode、web、present、子代理/工作流。所以这个 agent 碰不到机器和网络。

## 读取会话消息

`session_read` 走的是 `sessionController.inspect(sessionId)`，它返回该会话的**完整事件日志**（活跃会话取内存快照，冷会话读持久化），所以三层细节都能给：

- `text`：`user/message`（只取 `source.kind === "user"` 的真实用户输入）+ `assistant/message` 的文本；
- `tools`：再加 `tool/call`（工具名 + 参数，参数截断到 400 字符）与 `tool/result`（结果文本，失败时带 `error.name: error.code`）；
- `all`：再加 `system/message`（插件注入的上下文）、assistant 的 `reasoning` 文本、`session/title` 变更。

读取**不会唤醒**目标会话（`inspect` 不 resolve Agent），也**不写任何东西**。

## 私有备注（`session_describe`）

`session_describe({ sessionId, description? })`：

- 给 `description` → 设置备注（trim 后截断到 200 字符）；给空串 → 清除；整个字段省略 → 读当前备注。
- 存在 `<DSH_HOME>/session-manager/descriptions.json`（`DSH_HOME` 未设时用 `~/.dsh`），形如 `{ "version": 1, "byId": { "<sessionId>": { "description": "...", "updatedAt": 0 } } }`。
- 它**不是会话标题**：不写进任何会话日志，所以侧栏、会话列表、轨迹视图、其他 agent 都看不到。只有本 preset 的 `session_list` 会显示 `note:`，画布（若在运行）会画在节点下方。
- 写入串行化（`withNotes` 用一条 promise 链），并发调用不会丢更新；写盘失败会把内存缓存回滚。
- **它不是保密边界**：文件就在 DSH home 里，任何进程都能打开。它是**归属边界**——除了这个 preset，没有别的东西读写它。

## 中途切换模型

`session_models()` 列出 `sessionController.modelCatalog()` 的内容：部署默认、可路由 provider、按 provider 分组的 model（带各自的 reasoning effort 与默认 effort），以及**发现失败**的 provider（没有凭据之类）。catalog 只是提示，不控制路由。

`session_model({ sessionId, provider?, model?, reasoningEffort? })`：

- **只给 sessionId = 读**。走的是 `modelSelection` 这个 session projection（`wire.view` 是 `{ lastUsed, next }`，随 `session_list` 一起下发），**冷会话也能读，且不会唤醒它**；该会话没有 projection 缓存时，插件自己 fold 日志（最后一条 `model/selection` 是 pending，最后一条 `request/header` 是实际用过的路由）作为回退。
  - `next` = 下一次请求会用哪个；`lastUsed` = 上一次记录下来的请求实际跑在哪个模型上。
- **给 provider + model = 切换**，走 `sessionController.selectModel` → `agent.session.append("model/selection", …)` + 设置下一次请求的选择。因为是逐请求生效，**运行中的会话在下一个 step 就会用新模型**，不用重启会话，也不用新开分支。只给一半（只有 provider 或只有 model）会被拒绝并提示。
- **两个副作用必须知道**：
  1. `selectModel` 内部还会 `agentDefaultModel.saveSelection(...)`，也就是把这次选择**同时存成部署默认**——之后新建的会话会从这个模型起步（UI 里的模型选择器行为相同）；
  2. 它会先 `resolveAgent`，所以**冷的会话会被唤醒**成一个 idle 的活会话。
- 失败码：`session/model-unavailable`（provider/model 不可路由，或该模型不支持指定的 reasoning effort）、`session/not-found`、`session/agent-busy`（目标是被 subagent routing 拥有的子会话）。

`session_list` 的每一行也会带 `| model provider/model`（没有 projection 时显示 `(unknown)`），这样协调者不必逐个读就能看出谁跑在贵模型上。

## 分叉语义

`session_fork({ sessionId, atSeq?, title? })`：

- **切点**：只在已完成轮次（`turn/end`）的边界上切。默认取最后一个；给了 `atSeq` 就取第一个 `seq >= atSeq` 的 `turn/end`，再把切点向后推到下一个 `turn/start`。
- **继承**：源会话的 agent preset 与工作目录（并挂到源会话所在 workspace）。
- **独立**：副本有自己的日志和 agent，创建后 idle；`session_read` / `session_send` / `session_stop` 对它全部有效，源会话不受影响。
- **标题**：不给 `title` 时自动改名为 `"<源标题> · fork"`，避免分支混淆。
- **注意**：切点之后源会话产生的内容**不在副本里**——要么先让它跑完一轮再分叉，要么分叉后把后续上下文补给副本。副本站起来用的是**当前默认模型**，不是源会话当时用的模型。

典型用法是「一份上下文，两个方向」：从同一个已完成轮次分出副本，分别 `session_send` 不同指示，再用 `session_read` 对比两边结论。

## 测试

```sh
node preset/tools/session-control.test.mjs
```

它用假 Cordis ctx + 临时 `DSH_HOME` 跑真实插件文件，覆盖：备注的写/读/清与落盘、`session_list` 的血统标注 / 备注 / 模型路由展示、`session_read` 三档 detail 的取舍与顺序、模型目录的渲染与失败项、模型**读取**（优先 projection、回退 fold 日志、不触发 resume）、模型**切换**（请求字段完整、半对参数被拒、副作用被披露）、发送/自投递拦截/空文本拦截/取消/分叉与自动命名。全部通过时退出码 0。

## 使用画布

画布是一个**动态 Cordis 包**：源码存在进程内存里，进程重启即消失。要跑起来：

1. 用 `cordis_define`（`kind: "new"`）新建插件，把 `plugins/session-canvas/host.js` 的**全文**作为 `code.host`，`client.js` 的**全文**作为 `code.client`；
2. 用 `cordis_run` 激活。**含 client 的包需要用户在 UI 里点对勾批准**（纯 host 包不需要）；
3. 批准后：侧栏底部 Settings 旁多一个三节点图标按钮，点它开关面板；面板默认打开。

两个文件都**不是 ES module**：整份文件就是传给 `cordis_define` 的函数体，所以它以顶层 `return {` 开头、不 import 任何东西——它在沙箱里求值，`ctx` / `harness` / `React` / `host` / `styles` / `console` 由沙箱提供。

> 与导出时的运行实例（`scanv-7` / `pkg-12`）的唯一差别：本仓库版本正确区分了「分叉」与「子会话」的血统标注，运行实例当时把任何带 `parentSession` 的会话都标成子会话。画布目前还**没有**显示私有备注。

## 重要边界

- **只看得见本进程**：`sessionController` 是本 DSH 进程内的会话表，别的 dsh 进程/服务上的会话看不到、管不了。
- **子会话不由本模式驱动**：`origin:"subagent"` 的会话被 ownership fence 拦住，只能由它的活父会话走 subagent 通道；**分叉不受此限制**（fork 不建立运行时父子关系，所以是普通会话）。
- **`session_send` 等于用户消息**：写进去的就是目标会话日志里的用户消息，目标会真的开始干活。
- **画布不持久**：要长期可用得把它做成真正的 client 插件包（`dsh.client` 元数据 + 浏览器 bundle），那需要 profile 安装加构建。
- **备注不随会话删除**：备注表按 session id 存；会话被删或归档后条目仍在（不清理，避免误删仍在用的备注）。

## 出处

从一台运行中的 DSH 上导出：preset 已通过 `ctx.agentPresets.standingKeyFor()` 真实挂载校验（组合能导入、config 合法、每行都能激活、没有把服务发布进根 realm），导出的 preset 文件与源目录逐字节一致（sha256 已核对），冒烟测试全绿。
