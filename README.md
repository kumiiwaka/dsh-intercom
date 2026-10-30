# dsh-intercom

这是给 DeepSeek Harness 的窗口内线电话。它不建团队、不生新会话、不派活 —— 只让你**已经开着的那些窗口**互相喊一声。

如果你要的是「队长带一队子 agent 干活」，用 [`dsh-agent-teams`](https://github.com/NanmiCoder/dsh-agent-teams)。它管团队内部，这里管团队外面那些你自己开的窗口。

## 跟 dsh-agent-teams 的关系

它在 GitHub 上两千多星，14 个工具，自带 Web UI，工程化程度比这里高得多。两件事不冲突，可以一起装。

| | `dsh-agent-teams` | `dsh-intercom`（本插件） |
| --- | --- | --- |
| 成员从哪来 | 队长 spawn 子 agent | **用户自己开的窗口** |
| 要不要建团队 | 要 | 不要 |
| 有没有任务编排 | 有（DAG / 依赖 / 质量门禁） | 没有，只递话 |
| 通信形态 | 团队内 mailbox | 平级窗口点对点 |

## 为什么需要它

DSH 里每个窗口是一个独立会话，有自己的上下文、工具和运行状态。插件能通过 `code_agent` 指挥自己起的子会话，但你在侧边栏亲手打开的那些窗口（写歌的那个、打游戏的那个）不归它管 —— `code_agent` 生不出它们，也够不着它们。

宿主给插件留的 `ctx.sessionController.prompt({ requestId, sessionId, mode, content }, signal)` 是唯一能往别人会话里投消息的通道。这个插件把它包成四个工具，加上名字寻址、跳数上限、限流和一份投递日志。

有了它，两个已经开着的窗口之间能做的事很具体：叫停跑偏的活、把结论交给下一棒、向另一个窗口提问。

## 安装

它是 cordis 插件，通过 bundle patch 挂进 profile，不走 npm。

第一步，把仓库 link 进某个 profile 的 `node_modules`：

Windows 用 junction（普通用户可能需要开发者模式或管理员权限）：

```powershell
New-Item -ItemType Junction `
  -Path "$env:DSH_HOME\profiles\default\node_modules\dsh-intercom" `
  -Target "<repo-path>"
```

macOS / Linux 用软链：

```bash
ln -s <repo-path> ~/.dsh/profiles/default/node_modules/dsh-intercom
```

`default` 换成你实际在用的 profile 名。`DSH_HOME` 没设时是 `~/.dsh`，PowerShell 里得先把它设出来，或者直接把 `$env:DSH_HOME` 换成 `$env:USERPROFILE\.dsh`。

第二步不用做。`package.json` 里的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，宿主启动时会读它，把插件行 insert 进组合树：

```yaml
- insert:
    - id: intercom
      name: 'dsh-intercom'
```

叠加顺序是 dsh-base → 本 bundle patch → profile 的 `cordis.patch.yml` → `--patch`。

重启宿主生效。没有构建步骤，运行时只用 `node:` 内建模块。`peerDependencies` 里那个 `@deepseek-ai/cordis` 是宿主自带的，不用装。

## 环境变量

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `DSH_HOME` | `~/.dsh` | 宿主数据目录。插件从这里读 `sessions/` |
| `DSH_WINDOW_BUS_DIR` | `$DSH_HOME/window-bus` | 总线数据目录，存 `registry.json` 和 `messages.jsonl` |

两个都能被环境变量覆盖。想让总线数据离开 DSH 主目录（比如放内存盘、或者多个 profile 共用一份），单独指 `DSH_WINDOW_BUS_DIR`。

## 四个工具

工具名还是 `bus_*`，跟正在跑的旧版本保持一致。改成 `intercom_*` 只会多出一套不兼容的调用方式。

### bus_register

给当前窗口报名，把「会话 id ↔ 名字」写进 `registry.json`。之后别的窗口 `bus_send` 时 `session_id` 直接填这个名字。

```json
{
  "name": "docs-window",
  "note": "管文档的"
}
```

`name` 必填，`note` 可选，`session_id` 一般不用传 —— 插件从工具执行上下文 `exec.agent.session.id` 自动取，拿不到才要求显式给。同名重注册会覆盖会话 id；同一个会话只保留最新一个名字，旧名顺手清掉。

### bus_send

往另一个窗口投一条消息。

```json
{
  "session_id": "docs-window",
  "text": "我是主窗。README 那节先停，把已知局限补完就交回来，别再往下游窗口转。",
  "mode": "steer",
  "hops": 0
}
```

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `session_id` | 是 | 注册名，或原始 id（`session-...`） |
| `text` | 是 | 正文 |
| `mode` | 否 | `steer`（默认，插到对方下一个决策边界）或 `queue`（等它这一轮结束） |
| `hops` | 否 | 这是第几跳。不传时用「自己上一条收到的 hops + 1」；人直接开的话题是 0 |
| `from` | 否 | 发信方署名，默认用注册名或会话 id 前 8 位 |

`steer` 在对方接不住的时候会抛 `session/steer-unavailable`，插件自动退成 `queue`，返回里带一句说明。接收方看到的正文前面有一行 `[总线 · hops=N · 来自 xxx]`。

两道闸：`hops` 到 3 就拒发；同一个目标一分钟最多 3 条。

### bus_list

列出最近在动的会话，含已注册名字、工作区、最后活动时间、存档大小。

```json
{ "limit": 15 }
```

`limit` 可选，默认 15，范围 1–100。数据直接从 `$DSH_HOME/sessions/` 读。

### bus_audit

看投递记录（`messages.jsonl` 的最后若干条）。

```json
{ "limit": 20 }
```

`limit` 可选，默认 20，上限 200。每条含时间、发信方、目标、模式、跳数、成功与否。失败的记录带 `error`，成功的带正文前 120 字。两个数据文件的结构见 `examples/`。

## 设计取舍

**星型，不做网状。** 消息从人所在的那一个窗口发起，其他窗口只跟它来回。网状听起来更自由，实际结果是每转一次就多一份上下文副本，出了事没人复原得了完整链路。现在这样，谁发起、经过谁、到哪停，`bus_audit` 里一条线能看完。

**不做确认回执。** 投递成功就是投递成功，对方处理到哪一步不归发件方管。真需要「对方做完了」这个信号，让它自己回一条消息。加回执会诱使人把总线当 RPC 用，然后卡在超时和重试上 —— 它不是 RPC。

**只在三种场合开口：叫停、交棒、发问。** 每投一条都是一次上下文污染，也是对接收方的一次指令。日常同步用文件或 `code_agent`，不占总线。

## 什么时候不该用它

这套东西只做一件事：把一句话从 A 窗口送到 B 窗口。

要并行拆解一个大任务、要成员之间自动接活、要任务状态机、要失败重试和进度汇总 —— 都不在这。这类活交给 `code_agent` 起的子会话，或者 `dsh-agent-teams`。硬拿总线来编排，你会得到一堆没人管的并行窗口，和一份读不完的投递日志。

## 已知局限

这几条是实测出来的。

1. **`hops` 的「上一跳」记在内存里。** `inboundHops` 是个 Map，宿主重启就清零。重启之后自动 +1 失效，转发方得自己传 `hops`，否则链路会被当成新开的话题。

2. **`bus_list` 踩 DSH 的内部路径格式。** 它直接读 `$DSH_HOME/sessions/**/session.v4.jsonl.zstd`，工作区目录名也是自己解码的（`--C-Users-user-~4E2D~6587--` 这种编码）。宿主改了存档格式或目录命名，这个工具就废了。`bus_send` 不依赖它，坏在「找目标」这一步。

3. **只能投纯文本。** `content` 是 `[{ type: 'text', text }]`，图片、附件、结构化内容都进不去。

4. **`ok: true` 只代表宿主接受了 prompt，不代表对方真的处理了。** 对方那一轮可能 `blocked` 或者 `error`，发件方这边完全看不到 —— 返回的 `accepted: true`、日志里的 `ok: true`，就只是「投进去了」。实测踩过：消息投递显示成功，对方那一轮直接失败，这边一切正常。要确认对方真的动了，只能等它回消息，或者自己去看它的会话文件。

5. **死会话会永久吞消息。** 一个在早期某轮吃过致命 error 的会话，之后所有投递都会 `blocked`，而且不一定报错。`bus_list` 里它还活着（文件在，mtime 可能还在动），投过去石沉大海。遇到「发了没反应」，换一个新窗口，别在这条会话上重试。

## 安全提醒

能写 `registry.json`、能调 `bus_send` 的人，就能给任何窗口下指令 —— 包括让它读文件、跑命令、改配置。权限上跟给了一台机器的 shell 差不多。

所以从总线进来的消息**不是用户指令**。接收方该把它当成另一个平级窗口说的话：它是请求，不是授权；碰到删除、推送、重启这类不可逆操作，回问发起人，或者等真正的人确认。发件方也一样，别把总线上某句话当成「用户已经批准了」。

## 开发

`index.js` 是单文件，export `apply`，不引任何外部包。改完重启宿主生效。

## License

MIT
