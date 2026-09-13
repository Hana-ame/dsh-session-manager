# DSH 会话管理模式

一个 [DSH](https://github.com/deepseek-ai/deepseek-harness)（DeepSeek Harness）agent preset：**这个模式下的会话只用来管理其他会话**。它不写代码、不改文件、不跑命令、不访问网络，只能观察、分叉、指挥本 DSH 进程内的其他会话，并在这些会话与用户之间协调信息。

配套还有一个会话关系画布（Session Canvas）：把进程内所有会话画成节点，按工作目录分组，用连线表示父子/分叉关系。

## 目录结构

```
preset/                              # 可直接使用的 agent preset（拷进 DSH 用户 preset 根目录即可）
├── agent.cordis.yml                 # Cordis 组合
├── preset.yml                       # 显示名与描述
└── tools/session-control.mjs        # 5 个会话管理工具的持久实现

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
| `session_list` | 列出**其他**会话（自己永远排除）：id、工作目录、标题、运行状态、血统（顶层 / 某个会话的分叉 / 子会话）。默认只看当前工作目录，`scope:"all"` 看全进程 |
| `session_read` | **只读**读某个会话最近的对话消息（user/assistant 文本，工具调用与思考过程省略）。不唤醒、不写入 |
| `session_send` | 投递一条提示并唤醒目标：`queue`（默认，等它当前轮次结束）/ `steer`（在最近的 step 边界插入） |
| `session_stop` | 取消某活跃会话的当前轮次，保留其已排队消息 |
| `session_fork` | 在某个**已完成轮次**的边界上把会话分叉成独立副本，返回新的 session id |

组合里还有 `persona`（协调者人格）、`ask_user_question`、`todo_write`、goal 与 compaction。

**刻意不包含**：shell（bash/pwsh）、文件与搜索、后台任务、skills、plan mode、web、present、子代理/工作流。所以这个 agent 碰不到机器和网络。

## 分叉语义

`session_fork({ sessionId, atSeq?, title? })`：

- **切点**：只在已完成轮次（`turn/end`）的边界上切。默认取最后一个；给了 `atSeq` 就取第一个 `seq >= atSeq` 的 `turn/end`，再把切点向后推到下一个 `turn/start`。
- **继承**：源会话的 agent preset 与工作目录（并挂到源会话所在 workspace）。
- **独立**：副本有自己的日志和 agent，创建后 idle；`session_read` / `session_send` / `session_stop` 对它全部有效，源会话不受影响。
- **标题**：不给 `title` 时自动改名为 `"<源标题> · fork"`，避免分支混淆。
- **注意**：切点之后源会话产生的内容**不在副本里**——要么先让它跑完一轮再分叉，要么分叉后把后续上下文补给副本。副本站起来用的是**当前默认模型**，不是源会话当时用的模型。

典型用法是「一份上下文，两个方向」：从同一个已完成轮次分出副本，分别 `session_send` 不同指示，再用 `session_read` 汇总两边结论对比。

## 使用画布

画布是一个**动态 Cordis 包**：源码存在进程内存里，进程重启即消失。要跑起来：

1. 用 `cordis_define`（`kind: "new"`）新建插件，把 `plugins/session-canvas/host.js` 的**全文**作为 `code.host`，`client.js` 的**全文**作为 `code.client`；
2. 用 `cordis_run` 激活。**含 client 的包需要用户在 UI 里点对勾批准**（纯 host 包不需要）；
3. 批准后：侧栏底部 Settings 旁多一个三节点图标按钮，点它开关面板；面板默认打开。

两个文件都**不是 ES module**：整份文件就是传给 `cordis_define` 的函数体，所以它以顶层 `return {` 开头、不 import 任何东西——它在沙箱里求值，`ctx` / `harness` / `React` / `host` / `styles` / `console` 由沙箱提供。

> 与导出时的运行实例（`scanv-7` / `pkg-12`）的唯一差别：本仓库版本正确区分了「分叉」与「子会话」的血统标注，运行实例当时把任何带 `parentSession` 的会话都标成子会话。

## 重要边界

- **只看得见本进程**：`sessionController` 是本 DSH 进程内的会话表，别的 dsh 进程/服务上的会话看不到、管不了。
- **子会话不由本模式驱动**：`origin:"subagent"` 的会话被 ownership fence 拦住，只能由它的活父会话走 subagent 通道；**分叉不受此限制**（fork 不建立运行时父子关系，所以是普通会话）。
- **`session_send` 等于用户消息**：写进去的就是目标会话日志里的用户消息，目标会真的开始干活。
- **读不到工具细节**：`session_read` 只有对话文本；需要细节就直接问那个会话。
- **画布不持久**：要长期可用得把它做成真正的 client 插件包（`dsh.client` 元数据 + 浏览器 bundle），那需要 profile 安装加构建。

## 出处

从一台运行中的 DSH 上导出：preset 已通过 `ctx.agentPresets.standingKeyFor()` 真实挂载校验（组合能导入、config 合法、每行都能激活、没有把服务发布进根 realm）。导出的 preset 文件与源目录逐字节一致（sha256 已核对）。
