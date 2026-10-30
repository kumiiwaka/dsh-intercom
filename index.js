/**
 * dsh-intercom v0.3 —— 窗口之间真正说话的那条线
 *
 * 四个工具：
 *   bus_register(name, note?, session_id?)  窗口自报名（当前会话 id ↔ 名字），省手抄会话 ID
 *   bus_send(session_id, text, mode, hops)  投递一条消息（steer 实时 / queue 排队），session_id 可填注册名
 *   bus_list(limit?)                        最近在动的会话清单（从磁盘读，含工作区、已注册名字）
 *   bus_audit(limit?)                       看投递记录（messages.jsonl）
 *
 * 底层走官方接口：ctx.sessionController.prompt({ requestId, sessionId, mode, content }, signal)
 *   mode 只有 'queue' | 'steer' 两个值（dsh-api-session-controller/lib/types/types.d.ts L323）
 *   第二个参数 signal 是必填的（内部会 signal.throwIfAborted()），传 undefined 会崩
 *   steer 不可用时抛 session/steer-unavailable → 自动退 queue
 *
 * 当前会话 id 的来源：执行上下文 exec.agent.session.id（宿主官方取法，见
 *   @deepseek-ai/dsh-tool-session-query 的 callerOf()：exec.agent.session.id / header）。
 *   拿不到时 bus_register 退化成要求调用方显式传 session_id。
 *
 * 防环两道闸（并行，互不替代）：
 *   ① 跳数：每条消息带 hops（人直接开的话题 = 0，窗口转发 +1）。hops >= MAX_HOPS 直接拒发。
 *   ② 限流：同一目标一分钟最多 RATE_MAX 条。
 *   接收方会在正文前看到一行 `[总线 · hops=N · 来自 xxx]`，一眼看出链路位置。
 *
 * 零外部 import（只用 node: 内建）：Node 的 ESM 解析从本文件真实路径向上找 node_modules。
 * 本插件是 link 进 profile 的，@deepseek-ai/* 不在插件目录上层的 node_modules 里，
 * 静态 import 核心包会让插件加载即崩。
 */

import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
/** 总线数据目录（messages.jsonl / registry.json）。默认落在 DSH_HOME 下，人眼好查；DSH_WINDOW_BUS_DIR 可单独指走。 */
const BUS_DIR = process.env.DSH_WINDOW_BUS_DIR ?? join(DSH_HOME, 'window-bus')
const MESSAGES = join(BUS_DIR, 'messages.jsonl')
const REGISTRY = join(BUS_DIR, 'registry.json')
const SESSIONS = join(DSH_HOME, 'sessions')

/** 同一个目标在窗口期内的投递上限（防刷屏）。和跳数是两道并行的闸。 */
const RATE_WINDOW_MS = 60_000
const RATE_MAX = 3
const recent = new Map()

/** 线程跳数上限：hops 从 0 数，hops >= MAX_HOPS 即「第 MAX_HOPS+1 跳」，拒发。 */
const MAX_HOPS = 3
/** 每个会话最近一次收到的 hops：它往后转发时自动 +1，不用人肉数。 */
const inboundHops = new Map()

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

async function appendMessage(record) {
  await mkdir(BUS_DIR, { recursive: true })
  await appendFile(MESSAGES, JSON.stringify(record) + '\n', 'utf8')
}

/**
 * `--C-Users-user-~4E2D~6587--` → `Users\user\中文`（首段 `C` 还原成盘符 `C:`）
 *
 * 编码规则：`--` 包住整条路径；`-` 是分隔符；非 ASCII 字符写成 `~XXXX~`（UTF-16 码点，
 * 相邻的共用一个 `~`，所以必须按 `~` 切、不能按固定长度匹配）。首段如果只有一个字母，
 * 那是盘符，补回冒号。
 */
function decodeWorkspace(dirName) {
  const body = dirName.replace(/^--/, '').replace(/--$/, '')
  const parts = body.split('-').map((part) => {
    if (!part.includes('~')) return part
    return part
      .split('~')
      .filter((chunk) => chunk !== '')
      .map((chunk) => {
        const code = parseInt(chunk, 16)
        return Number.isFinite(code) && /^[0-9A-Fa-f]+$/.test(chunk) ? String.fromCharCode(code) : chunk
      })
      .join('')
  })
  if (parts.length > 0 && /^[A-Za-z]$/.test(parts[0])) parts[0] = `${parts[0]}:`
  return parts.join('\\')
}

/** ISO 时间 → 本地 `YYYY-MM-DD HH:mm`。 */
function localTime(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 当前会话 id：宿主把 agent 挂在工具执行上下文上（exec.agent.session.id）。拿不到返回 undefined。 */
function sessionIdOf(exec) {
  const candidates = [
    exec?.agent?.session?.id,
    exec?.agent?.sessionId,
    exec?.session?.id,
    exec?.sessionId
  ]
  for (const candidate of candidates) {
    const id = textOf(candidate)
    if (id !== '') return id
  }
  return undefined
}

/** `session-1a2b3c4d-...` → `1a2b3c4d`；总线前缀里用短 id 省地方。 */
function shortId(id) {
  const body = id.replace(/^session-?/i, '')
  return body === '' ? id : body.slice(0, 8)
}

/** 读注册表。文件不存在 / 坏掉 / 结构不对都退回空表，绝不抛。 */
async function readRegistry() {
  try {
    const parsed = JSON.parse(await readFile(REGISTRY, 'utf8'))
    const windows = parsed?.windows
    if (windows !== null && typeof windows === 'object' && !Array.isArray(windows)) {
      return { updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : undefined, windows }
    }
  } catch {
    /* 没注册过 or 文件坏了 → 空表 */
  }
  return { updated_at: undefined, windows: {} }
}

/** 注册表读-改-写串行化，防两个工具同时写互相覆盖。 */
let registryLock = Promise.resolve()
function withRegistry(fn) {
  const run = registryLock.then(fn, fn)
  registryLock = run.then(() => undefined, () => undefined)
  return run
}

async function writeRegistry(windows) {
  const updatedAt = localTime(new Date().toISOString())
  const payload = { updated_at: updatedAt, windows }
  await mkdir(BUS_DIR, { recursive: true })
  await writeFile(REGISTRY, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  return { updated_at: updatedAt, windows }
}

/**
 * 注册表双向索引：名字 → 会话 id，会话 id → 名字。
 * 同一个 id 有多个名字时取第一个（bus_register 会主动清理旧名，这里只是兜底）。
 */
function nameIndex(registry) {
  const byName = new Map()
  const byId = new Map()
  for (const [name, entry] of Object.entries(registry.windows)) {
    const id = textOf(entry?.session_id)
    if (id === '') continue
    byName.set(name, id)
    if (!byId.has(id)) byId.set(id, name)
  }
  return { byName, byId }
}

/** 本跳是第几跳：显式 hops 优先；否则拿「自己上一条收到的 hops + 1」；都没有 = 0（人直接开题）。 */
function resolveHops(args, selfId) {
  if (Number.isFinite(args.hops)) return Math.max(0, Math.trunc(args.hops))
  const inbound = selfId === undefined ? undefined : inboundHops.get(selfId)
  return inbound === undefined ? 0 : inbound + 1
}

/** 接收方看到的宣告行。 */
function hopPrefix(hops, fromLabel) {
  return `[总线 · hops=${hops} · 来自 ${fromLabel}]`
}

async function listSessions(limit) {
  let workspaces
  try {
    workspaces = await readdir(SESSIONS, { withFileTypes: true })
  } catch {
    return []
  }
  const registry = await readRegistry()
  const { byId } = nameIndex(registry)
  const rows = []
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue
    let sessions
    try {
      sessions = await readdir(join(SESSIONS, ws.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const s of sessions) {
      if (!s.isDirectory()) continue
      const file = join(SESSIONS, ws.name, s.name, 'session.v4.jsonl.zstd')
      let info
      try {
        info = await stat(file)
      } catch {
        continue
      }
      const name = byId.get(s.name)
      rows.push({
        session_id: s.name,
        ...name === undefined ? {} : { name },
        workspace: decodeWorkspace(ws.name),
        last_active: localTime(info.mtime.toISOString()),
        size_kb: Math.round(info.size / 1024)
      })
    }
  }
  rows.sort((a, b) => (a.last_active < b.last_active ? 1 : -1))
  return rows.slice(0, limit)
}

async function readAudit(limit) {
  try {
    const text = await readFile(MESSAGES, 'utf8')
    const lines = text.trim().split('\n').filter((l) => l !== '')
    return lines.slice(-limit).map((l) => {
      try { return JSON.parse(l) } catch { return { raw: l } }
    })
  } catch {
    return []
  }
}

function register(ctx, definition) {
  ctx.tools.register(definition)
}

const REGISTER_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string', description: '给这个窗口起的名字，之后别的窗口 bus_send 直接用它当 session_id。同名重注册 = 覆盖会话 id（幂等，不会堆多条）。' },
    note: { type: 'string', description: '可选备注，比如「管文档的」「跑长任务的」，方便别人一眼挑人。' },
    session_id: { type: 'string', description: '可选。当前会话 id；不传时插件从工具上下文（exec.agent.session.id）自动取。拿不到才需要你手填。' }
  }
}

const SEND_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['session_id', 'text'],
  properties: {
    session_id: { type: 'string', description: '目标会话：可以是注册名（先 bus_register 过的名字），也可以是原始 id（形如 session-xxxx，侧边栏会话右键菜单有「复制会话 ID」，或先用 bus_list 看）' },
    text: { type: 'string', description: '要投递给那个窗口的话。写清你是谁、要它做什么、什么时候回。' },
    mode: { type: 'string', enum: ['steer', 'queue'], description: 'steer ＝ 插到它下一个决策边界（正在跑也能收到）；queue ＝ 排队等这轮结束。默认 steer，失败自动退 queue。' },
    hops: { type: 'number', description: '可选。这条消息是第几跳（人直接开的话题 = 0）。不传时插件自动用「你上一条收到的 hops + 1」；总量上限 3 跳，超了会被拒。' },
    from: { type: 'string', description: '可选。发信方署名，覆盖自动推断的注册名/短 id。' }
  }
}

const LIST_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'number', description: '最多列几条，默认 15' }
  }
}

const COMMON_RENDER_NOTE = '对方收下了不等于做完了，要结果得等它回话或自己查文件。'

export function apply(ctx) {
  register(ctx, {
    name: 'bus_register',
    description: [
      '给自己这个窗口在总线上报名：把「当前会话 id ↔ 名字」写进 registry.json。',
      '之后别的窗口 bus_send 时 session_id 直接填这个名字就行，不用手抄会话 ID。',
      '当前会话 id 由插件自动从工具上下文取（拿不到才需要显式传 session_id）。',
      '同名重注册是覆盖，不会堆多条；同一个会话也只保留最新一个名字。'
    ].join(''),
    parameters: REGISTER_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        properties: {
          registered: { type: 'boolean' },
          name: { type: 'string' },
          session_id: { type: 'string' },
          updated_at: { type: 'string' },
          previous_session_id: { type: 'string' },
          replaced_names: { type: 'array', items: { type: 'string' } }
        },
        required: ['registered', 'name', 'session_id', 'updated_at']
      },
      render: (_a, value) => [{
        type: 'text',
        text: [
          `已登记：${value.name} → ${value.session_id}（${value.updated_at}）`,
          value.previous_session_id === undefined ? '' : `（覆盖了旧 id ${value.previous_session_id}）`,
          value.replaced_names !== undefined && value.replaced_names.length > 0 ? `（顺手清掉了同一会话的旧名字：${value.replaced_names.join('、')}）` : '',
          '别的窗口现在可以 bus_send 到这个名字了。'
        ].join('')
      }]
    },
    presentCall: (args) => ({ card: 'generic', title: '总线报名', kind: 'execute', rawInput: { name: args.name } }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const name = textOf(args.name)
      if (name === '') throw new Error('bus_register: name 不能为空')
      const explicit = textOf(args.session_id)
      const id = explicit === '' ? sessionIdOf(exec) : explicit
      if (id === undefined) {
        throw new Error('bus_register: 拿不到当前会话 id（工具上下文里没有 agent.session.id），请显式传 session_id —— 侧边栏会话右键菜单有「复制会话 ID」。')
      }
      return withRegistry(async () => {
        const registry = await readRegistry()
        const previous = textOf(registry.windows[name]?.session_id)
        const replaced = []
        for (const [other, entry] of Object.entries(registry.windows)) {
          if (other !== name && textOf(entry?.session_id) === id) {
            delete registry.windows[other]
            replaced.push(other)
          }
        }
        registry.windows[name] = {
          session_id: id,
          note: textOf(args.note),
          updated_at: localTime(new Date().toISOString())
        }
        const written = await writeRegistry(registry.windows)
        return {
          registered: true,
          name,
          session_id: id,
          updated_at: written.updated_at,
          ...previous === '' || previous === id ? {} : { previous_session_id: previous },
          replaced_names: replaced
        }
      })
    }
  })

  register(ctx, {
    name: 'bus_send',
    description: [
      '给另一个窗口（另一个 DSH 会话）投递一条消息。这是唯一能让平级窗口互相说话的工具。',
      'code_agent 只能指挥自己起的后台会话，管不了别的窗口。',
      '先 bus_list 找目标，再 bus_send。session_id 可填注册名或原始 id。mode 默认 steer（实时插话），失败自动退 queue。',
      '投过去的话对它来说是一条「用户消息」，它会当成用户在跟它说话 —— 所以写清「我是谁、从哪来」要么干脆当普通对话写。',
      '每条消息带跳数 hops（人直接开的话题 = 0，转发 +1），最多 3 跳；另有一分钟 3 条的限流。',
      '投递成功只代表它收下了，不代表它做完了。'
    ].join(''),
    parameters: SEND_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        properties: {
          accepted: { type: 'boolean' },
          session_id: { type: 'string' },
          name: { type: 'string' },
          mode: { type: 'string' },
          hops: { type: 'number' },
          from: { type: 'string' },
          note: { type: 'string' }
        },
        required: ['accepted', 'session_id', 'mode', 'hops', 'from']
      },
      render: (_a, value) => {
        const target = value.name === undefined ? value.session_id : `${value.name}（${value.session_id}）`
        return [{
          type: 'text',
          text: `已投递到 ${target}（${value.mode} · hops=${value.hops} · 来自 ${value.from}）${value.note === undefined ? '' : `。${value.note}`}。${COMMON_RENDER_NOTE}`
        }]
      }
    },
    presentCall: (args) => ({ card: 'generic', title: '向另一个窗口发消息', kind: 'execute', rawInput: { session_id: args.session_id, mode: args.mode ?? 'steer', hops: args.hops } }),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const targetInput = textOf(args.session_id)
      const text = textOf(args.text)
      if (targetInput === '') throw new Error('bus_send: session_id 不能为空')
      if (text === '') throw new Error('bus_send: text 不能为空')

      const registry = await readRegistry()
      const { byName, byId } = nameIndex(registry)
      const targetId = byName.get(targetInput) ?? targetInput
      const targetName = byName.has(targetInput) ? targetInput : byId.get(targetId)

      const selfId = sessionIdOf(exec)
      const selfLabel = textOf(args.from) !== ''
        ? textOf(args.from)
        : (selfId === undefined ? '' : (byId.get(selfId) ?? shortId(selfId))) || '匿名窗口'
      const hops = resolveHops(args, selfId)

      if (hops >= MAX_HOPS) {
        await appendMessage({
          at: new Date().toISOString(),
          from: selfLabel,
          to: targetId,
          to_name: targetName,
          mode: args.mode === 'queue' ? 'queue' : 'steer',
          hops,
          ok: false,
          error: `hops=${hops} 已经到上限 ${MAX_HOPS} 跳`
        })
        throw new Error(`bus_send: 拒发 —— 这条会变成第 ${hops + 1} 跳（hops=${hops}，上限 ${MAX_HOPS} 跳），链路该收了。把结论直接回给主窗或发起人，别再往别的窗口转。`)
      }

      const now = Date.now()
      const hits = (recent.get(targetId) ?? []).filter((t) => now - t < RATE_WINDOW_MS)
      if (hits.length >= RATE_MAX) {
        throw new Error(`bus_send: 对 ${targetId} 一分钟内已经发了 ${hits.length} 条（上限 ${RATE_MAX} 条），先停一下 —— 防环。真要继续就等一会儿。`)
      }
      hits.push(now)
      recent.set(targetId, hits)

      const wanted = args.mode === 'queue' ? 'queue' : 'steer'
      const signal = exec !== void 0 && exec.signal !== void 0 ? exec.signal : new AbortController().signal
      const content = [{ type: 'text', text: `${hopPrefix(hops, selfLabel)}\n${text}` }]
      const send = async (mode) => ctx.sessionController.prompt({
        requestId: `bus-${randomUUID()}`,
        sessionId: targetId,
        mode,
        content
      }, signal)

      let used = wanted
      let note
      try {
        await send(wanted)
      } catch (error) {
        if (wanted !== 'steer') {
          await appendMessage({ at: new Date().toISOString(), from: selfLabel, to: targetId, to_name: targetName, mode: wanted, hops, ok: false, error: String(error).slice(0, 200) })
          throw error
        }
        await send('queue')
        used = 'queue'
        note = 'steer 不可用（对方当前接不了实时注入），已改为排队投递'
      }

      await appendMessage({ at: new Date().toISOString(), from: selfLabel, to: targetId, to_name: targetName, mode: used, hops, ok: true, preview: text.slice(0, 120) })
      // 对方下一次转发时以这一跳为基准 +1（内存态，重启会丢，届时可显式传 hops）。
      inboundHops.set(targetId, hops)
      return {
        accepted: true,
        session_id: targetId,
        ...targetName === undefined ? {} : { name: targetName },
        mode: used,
        hops,
        from: selfLabel,
        ...note === undefined ? {} : { note }
      }
    }
  })

  register(ctx, {
    name: 'bus_list',
    description: '列出最近在动的 DSH 会话（从磁盘读 sessions 目录），含 session_id、已注册名字、工作区、最后活动时间、存档大小。找投递目标用。只读。',
    parameters: LIST_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        properties: {
          count: { type: 'number' },
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              properties: { session_id: { type: 'string' }, name: { type: 'string' }, workspace: { type: 'string' }, last_active: { type: 'string' }, size_kb: { type: 'number' } },
              required: ['session_id', 'last_active']
            }
          }
        },
        required: ['count', 'sessions']
      },
      render: (_a, value) => [{
        type: 'text',
        text: value.sessions.length === 0
          ? '没读到任何会话。'
          : ['最近的会话：', ...value.sessions.map((s) => `· ${s.name === undefined ? s.session_id : `${s.name}（${s.session_id}）`}  |  ${s.last_active}  |  ${s.size_kb ?? 0} KB  |  ${s.workspace ?? ''}`)].join('\n')
      }]
    },
    presentCall: () => ({ card: 'generic', title: '列出会话', kind: 'read' }),
    isConcurrencySafe: () => true,
    async execute(args) {
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(100, Math.trunc(args.limit))) : 15
      const sessions = await listSessions(limit)
      return { count: sessions.length, sessions }
    }
  })

  register(ctx, {
    name: 'bus_audit',
    description: '看窗口总线的投递记录（messages.jsonl 的最后若干条），含跳数 hops 和发信方 from。只读。查「谁给谁发过什么」用它。',
    parameters: LIST_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        properties: { count: { type: 'number' }, entries: { type: 'array', items: { type: 'object' } } },
        required: ['count', 'entries']
      },
      render: (_a, value) => [{
        type: 'text',
        text: value.entries.length === 0
          ? '还没有投递记录。'
          : value.entries.map((e) => {
            const from = e.from === undefined ? '' : `[${e.from}] `
            const hops = e.hops === undefined ? 'hops=?' : `hops=${e.hops}`
            const body = e.ok === false ? ' ❌ ' + (e.error ?? '') : ' ' + (e.preview ?? '')
            return `· ${e.at ?? e.raw} ${from}→ ${e.to ?? '?'}（${e.mode ?? '?'} · ${hops}）${body}`
          }).join('\n')
      }]
    },
    presentCall: () => ({ card: 'generic', title: '看投递记录', kind: 'read' }),
    isConcurrencySafe: () => true,
    async execute(args) {
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(200, Math.trunc(args.limit))) : 20
      const entries = await readAudit(limit)
      return { count: entries.length, entries }
    }
  })
}

export const name = 'intercom'
export const inject = ['tools', 'sessionController']

export default { name, inject, apply }
