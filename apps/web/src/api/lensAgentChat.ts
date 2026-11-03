/**
 * Lens 画布 Agent 对话适配层 v2
 *
 * <p>画布页面的 AI 对话后端走 lens Java 最小桥 `POST /api/canvas/agent/chat`（SSE），
 * Java 桥负责组装请求、调用 agents-cli 并把原版 agent 事件转发回来。本模块只负责：</p>
 * <ol>
 *   <li>请求适配：tapcanvas `AgentsChatRequestDto` → lens 桥请求
 *       `{ prompt, dramaId, episodeNum, sessionId, selectedNodeId?, history? }`；</li>
 *   <li>事件透传：把 Java 桥的 SSE 事件（initial/session/thinking/content/tool/todo_list/
 *       thread.* /turn.* /item.* /result/error/done）原样解析成 tapcanvas
 *       `AgentsChatStreamEvent`，不做任何业务映射，AiChatDialog 零感知差异；</li>
 *   <li>画布 reload：提供 {@link reloadLensCanvasFlow}，由 LensCanvasApp 注册的 reload 函数
 *       读取 lens 最新 flow、同步 flowVersion 并合并节点，供 flow_patch 后刷新画布
 *       （避免前端自动保存用旧版本号触发 409）。</li>
 * </ol>
 */
import { createSseEventParser } from './sse'
import type {
  AgentsChatRequestDto,
  AgentsChatResponseDto,
  AgentsChatStreamEvent,
} from './server'

/** lens 画布 Agent 对话接口（lens 画布与后端同源，用相对路径） */
const LENS_AGENT_CHAT_ENDPOINT = '/api/canvas/agent/chat'

/** lens 聊天会话 ID 的 sessionStorage key（与分镜板 AgentChatWidget 保持一致，Tab 级隔离） */
const LENS_CHAT_SESSION_STORAGE_KEY = 'agentChatSessionId'

/** lens 画布 reload 结果 */
export type LensCanvasReloadResult = {
  /** 是否真正执行了 reload */
  reloaded: boolean
  /** reload 后新增的节点 id（供 autoRun 使用） */
  newNodeIds: string[]
}

/** LensCanvasApp 注册到 window 上的 reload 句柄类型 */
type LensCanvasReloadHolder = {
  __lensCanvasAgentReloadFlow?: () => Promise<LensCanvasReloadResult>
}

/** 画布作用域查询参数 */
type LensCanvasQuery = {
  dramaId: number
  episodeNum: number
}

/**
 * lens 画布模式判定：URL 带 dramaId 参数。
 *
 * <p>与 App.tsx#isLensCanvasRoute 的判定保持一致；只有 lens 画布入口才走本适配层，
 * tapcanvas 原生画布（无 dramaId）仍走 `/public/agents/chat`。</p>
 *
 * @returns true 表示当前是 lens 画布页面
 */
export function isLensCanvasMode(): boolean {
  return readLensCanvasQuery() !== null
}

/**
 * 读取 lens 画布作用域参数（dramaId + episodeNum）。
 *
 * @returns 作用域参数；非 lens 画布或参数非法时返回 null
 */
function readLensCanvasQuery(): LensCanvasQuery | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  const dramaRaw = String(params.get('dramaId') || '').trim()
  if (!dramaRaw) return null
  const dramaId = Number(dramaRaw)
  if (!Number.isFinite(dramaId) || dramaId <= 0) return null
  const episodeRaw = Number(params.get('episode') || 1)
  const episodeNum = Number.isFinite(episodeRaw) && episodeRaw > 0 ? Math.trunc(episodeRaw) : 1
  return { dramaId: Math.trunc(dramaId), episodeNum }
}

/**
 * 读取 cookie（lens 的 Admin-Token 存在 cookie，画布与 lens 后端同 host 共享）。
 *
 * @param name cookie 名
 * @returns cookie 值，不存在时返回 null
 */
function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`))
  return match ? decodeURIComponent(match[1]) : null
}

/**
 * 生成请求 ID（优先使用 crypto.randomUUID，兼容不支持的环境）。
 *
 * @returns 请求唯一标识
 */
function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 解析 lens 聊天会话 ID（Tab 级，存 sessionStorage）。
 *
 * <p>Java 桥会把它和 dramaId/episode 一起做命名空间隔离，这里只保证同一 Tab 内稳定。</p>
 *
 * @returns 会话 ID（不存在时生成并写回）
 */
function resolveLensChatSessionId(): string {
  if (typeof window === 'undefined') return createRequestId()
  try {
    const existing = String(window.sessionStorage.getItem(LENS_CHAT_SESSION_STORAGE_KEY) || '').trim()
    if (existing) return existing
    const next = createRequestId()
    window.sessionStorage.setItem(LENS_CHAT_SESSION_STORAGE_KEY, next)
    return next
  } catch (error) {
    // 隐私模式/禁用 sessionStorage：退化为单次请求 ID，不阻断对话
    console.warn('[lensAgentChat] sessionStorage 不可用，使用临时 sessionId', error)
    return createRequestId()
  }
}

/** 历史会话摘要（来自 agents-cli 会话目录，按 (userId, 剧:集) 隔离） */
export type LensChatSessionSummary = {
  /** 前端 Tab 级会话 ID（不含剧集命名空间） */
  sessionId: string
  /** 首条用户消息摘要 */
  preview: string
  /** 最后更新时间（ISO 字符串） */
  updatedAt: string
  /** 消息条数 */
  messageCount: number
}

/** 历史会话消息（用于恢复对话） */
export type LensChatHistoryMessage = {
  /** 角色：用户/助手 */
  role: 'user' | 'assistant'
  /** 消息文本 */
  content: string
}

/**
 * 读取当前 Tab 的 lens 聊天会话 ID（首次访问生成并写入 sessionStorage）。
 *
 * @returns 会话 ID
 */
export function getLensChatSessionId(): string {
  return resolveLensChatSessionId()
}

/**
 * 切换到指定历史会话（写回 sessionStorage，后续对话沿用它）。
 *
 * @param sessionId 历史会话 ID（不含剧集命名空间）
 */
export function setLensChatSessionId(sessionId: string): void {
  const normalized = String(sessionId || '').trim()
  if (!normalized) return
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(LENS_CHAT_SESSION_STORAGE_KEY, normalized)
  } catch (error) {
    console.warn('[lensAgentChat] 写入会话 ID 失败', error)
  }
}

/**
 * 开启新对话：生成新会话 ID 并写回 sessionStorage。
 *
 * @returns 新会话 ID
 */
export function createLensChatSessionId(): string {
  const next = createRequestId()
  setLensChatSessionId(next)
  return next
}

/**
 * 发起 lens 会话接口 GET 请求（Admin-Token 鉴权 + RuoYi 结构解包）。
 *
 * @param path 接口路径（含查询串）
 * @returns data 字段
 */
async function lensAgentGetJson<T>(path: string): Promise<T> {
  const token = readCookie('Admin-Token')
  const response = await fetch(path, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    credentials: 'include',
  })
  let body: Record<string, unknown> | null = null
  try {
    body = await response.json() as Record<string, unknown>
  } catch {
    body = null
  }
  const code = Number(body?.code)
  if (!response.ok || (Number.isFinite(code) && code !== 200)) {
    const msg = String(body?.msg || body?.message || '').trim()
    throw new Error(msg || `会话接口请求失败：HTTP ${response.status}`)
  }
  if (!body || body.data === undefined) {
    throw new Error('会话接口返回数据为空')
  }
  return body.data as T
}

/**
 * 获取 lens 画布内置能力列表（12 个 tapcanvas skills 拷贝，只返回 key/名称/描述）。
 *
 * @returns 能力列表；失败时抛错，由菜单展示显式错误
 */
export async function listLensAgentSkills(): Promise<Array<{ key: string; name: string; description: string }>> {
  const data = await lensAgentGetJson<Array<{ key?: unknown; name?: unknown; description?: unknown }> | {
    skills?: Array<{ key?: unknown; name?: unknown; description?: unknown }>
  }>('/api/canvas/agent/skills')
  const rawItems = Array.isArray(data)
    ? data
    : Array.isArray((data as { skills?: unknown }).skills)
      ? (data as { skills: Array<{ key?: unknown; name?: unknown; description?: unknown }> }).skills
      : []
  return rawItems
    .map((item) => ({
      key: String(item?.key || '').trim(),
      name: String(item?.name || '').trim(),
      description: String(item?.description || '').trim(),
    }))
    .filter((item) => Boolean(item.key))
}

/**
 * 获取当前剧集的 lens 历史会话列表（最近 20 条）。
 *
 * @returns 会话摘要列表（失败时抛错，由调用方展示）
 */
export async function fetchLensChatSessions(): Promise<LensChatSessionSummary[]> {
  const query = readLensCanvasQuery()
  if (!query) return []
  const data = await lensAgentGetJson<{ sessions?: LensChatSessionSummary[] }>(
    `/api/canvas/agent/sessions?dramaId=${query.dramaId}&episodeNum=${query.episodeNum}&limit=20`,
  )
  return Array.isArray(data.sessions) ? data.sessions : []
}

/**
 * 恢复指定历史会话的消息。
 *
 * @param sessionId 历史会话 ID（不含剧集命名空间）
 * @returns 历史消息列表
 */
export async function fetchLensChatSessionMessages(sessionId: string): Promise<LensChatHistoryMessage[]> {
  const query = readLensCanvasQuery()
  if (!query) return []
  const encoded = encodeURIComponent(String(sessionId || '').trim())
  const data = await lensAgentGetJson<{ messages?: LensChatHistoryMessage[] }>(
    `/api/canvas/agent/sessions/${encoded}/messages?dramaId=${query.dramaId}&episodeNum=${query.episodeNum}`,
  )
  const messages = Array.isArray(data.messages) ? data.messages : []
  return messages.filter((message) => (
    (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string'
  ))
}

/**
 * 触发 lens 画布 reload（flow_patch 写库后调用）。
 *
 * <p>真正的加载逻辑在 LensCanvasApp 内（读取 lens flow、同步 flowVersion、合并节点），
 * 这里只做跨组件桥接：AiChatDialog 不直接依赖 LensCanvasApp 的内部状态。</p>
 *
 * @returns reload 结果；未注册 reload 函数时 returned.reloaded=false
 */
export async function reloadLensCanvasFlow(): Promise<LensCanvasReloadResult> {
  if (typeof window === 'undefined') return { reloaded: false, newNodeIds: [] }
  const holder = window as unknown as LensCanvasReloadHolder
  const reload = holder.__lensCanvasAgentReloadFlow
  if (typeof reload !== 'function') {
    return { reloaded: false, newNodeIds: [] }
  }
  try {
    return await reload()
  } catch (error) {
    console.warn('[lensAgentChat] 画布 reload 失败', error)
    return { reloaded: false, newNodeIds: [] }
  }
}

/**
 * 从错误响应体中提取可读错误信息。
 *
 * <p>lens 未认证时 RuoYi 可能返回 HTTP 200 + JSON {code:401,msg}，这里统一解析。</p>
 *
 * @param response fetch 响应
 * @returns 可读错误信息
 */
async function readLensChatErrorMessage(response: Response): Promise<string> {
  let message = `画布 Agent 对话失败：HTTP ${response.status}`
  try {
    const body = await response.json() as Record<string, unknown>
    const code = Number(body?.code)
    const msg = String(body?.msg || body?.message || '').trim()
    if (code === 401) {
      message = msg || '登录已过期，请重新登录后再使用 AI 对话'
    } else if (msg) {
      message = msg
    }
  } catch {
    // 非 JSON（网关错误页/空响应）：保留状态码信息
  }
  return message
}

/**
 * lens 对话流式入口（与 tapcanvas 的 agentsChatStream 同签名）。
 *
 * <p>事件原样透传：Java 桥已按 agents-cli 协议输出，AiChatDialog 直接消费。</p>
 *
 * @param payload  对话请求（取 prompt / sessionKey / canvasNodeId）
 * @param handlers 事件回调（onEvent / onOpen / onError）
 * @returns 中断函数（中止本次 SSE 连接）
 */
/** 画布 Agent 对话附件（与 Java CanvasAgentAttachment 对齐） */
export interface LensAgentAttachment {
  type: 'image' | 'video'
  url: string
  name?: string
}

/**
 * 上传对话附件到 lens OSS（不走 tapcanvas /public 接口）。
 *
 * @param file 图片或 mp4
 * @param type 附件类型
 * @returns OSS 地址与文件名
 */
export async function uploadLensChatAttachment(file: File, type: 'image' | 'video'): Promise<LensAgentAttachment> {
  const form = new FormData()
  form.set('file', file)
  const endpoint = type === 'video'
    ? '/api/oss/upload/video/lens-chat'
    : '/api/oss/upload/img/lens-chat'
  const token = readCookie('Admin-Token')
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
    credentials: 'include',
  })
  if (!response.ok) {
    throw new Error(`附件上传失败：HTTP ${response.status}`)
  }
  const body = await response.json() as { code?: number; msg?: string; data?: unknown }
  const url = typeof body?.data === 'string' ? body.data.trim() : ''
  if (Number(body?.code) !== 200 || !url) {
    throw new Error(body?.msg || '附件上传失败：接口未返回 URL')
  }
  return { type, url, name: file.name }
}

export async function lensAgentsChatStream(
  payload: AgentsChatRequestDto & { attachments?: LensAgentAttachment[] },
  handlers: {
    onEvent: (event: AgentsChatStreamEvent) => void
    onOpen?: () => void
    onError?: (error: Error) => void
  },
): Promise<() => void> {
  const query = readLensCanvasQuery()
  if (!query) {
    throw new Error('当前页面不是 lens 画布（缺少 dramaId 参数），无法发起画布 Agent 对话')
  }
  const controller = new AbortController()
  // agents-cli 按 (userId, sessionId) 持久化会话历史，这里只传 sessionId，不再由前端附带 history
  const sessionId = resolveLensChatSessionId()
  const prompt = String(payload.prompt || '').trim()
  if (!prompt) {
    throw new Error('对话内容不能为空')
  }
  // 与后端 NODE_ID_PATTERN 对齐：非法 id 直接忽略（降级为不传选中节点），避免整轮对话因格式返回 400
  const selectedNodeIdRaw = String(payload.canvasNodeId || '').trim()
  const selectedNodeId = /^[A-Za-z0-9_:.\-]{1,128}$/.test(selectedNodeIdRaw) ? selectedNodeIdRaw : ''
  if (selectedNodeIdRaw && !selectedNodeId) {
    console.warn('[lensAgentChat] selectedNodeId 格式非法，已忽略', selectedNodeIdRaw)
  }
  // 本轮启用的 lens 内置能力 key（服务端白名单校验；只传 key，不传前端拼接的 prompt）
  const skillKeyRaw = String(payload.chatContext?.skill?.key || '').trim()
  const skillKey = /^[A-Za-z0-9_-]{1,64}$/.test(skillKeyRaw) ? skillKeyRaw : ''
  if (skillKeyRaw && !skillKey) {
    console.warn('[lensAgentChat] skillKey 格式非法，已忽略', skillKeyRaw)
  }
  // 用户 @ 引用的画布节点 ID：与后端 NODE_ID_PATTERN 对齐 + 去重 + 最多 5 个
  const contextNodeIds = Array.isArray(payload.contextNodeIds)
    ? Array.from(new Set(payload.contextNodeIds
        .map((item) => String(item || '').trim())
        .filter((item) => /^[A-Za-z0-9_:.\-]{1,128}$/.test(item))))
        .slice(0, 5)
    : []
  // 本轮附件（最多 4 个；URL 必须 http(s)，非法项直接忽略并告警，避免整轮对话 400）
  const attachments = Array.isArray(payload.attachments)
    ? payload.attachments
        .filter((item) => item && (item.type === 'image' || item.type === 'video'))
        .filter((item) => /^https?:\/\//.test(String(item.url || '').trim()))
        .slice(0, 4)
        .map((item) => ({ type: item.type, url: String(item.url).trim(), ...(item.name ? { name: String(item.name).slice(0, 200) } : {}) }))
    : []
  if (Array.isArray(payload.attachments) && payload.attachments.length > attachments.length) {
    console.warn('[lensAgentChat] 存在非法或超量附件，已忽略')
  }
  const token = readCookie('Admin-Token')

  const response = await fetch(LENS_AGENT_CHAT_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      prompt,
      dramaId: query.dramaId,
      episodeNum: query.episodeNum,
      sessionId,
      ...(selectedNodeId ? { selectedNodeId } : {}),
      ...(skillKey ? { skillKey } : {}),
      ...(contextNodeIds.length ? { contextNodeIds } : {}),
      ...(attachments.length ? { attachments } : {}),
    }),
    credentials: 'include',
    signal: controller.signal,
  })

  if (!response.ok) {
    throw new Error(await readLensChatErrorMessage(response))
  }
  const contentType = String(response.headers.get('content-type') || '').toLowerCase()
  if (!contentType.includes('text/event-stream')) {
    throw new Error(await readLensChatErrorMessage(response))
  }
  if (!response.body) {
    throw new Error('画布 Agent 对话未返回流式响应体')
  }

  handlers.onOpen?.()

  /** 是否已收到终态事件（result/error/done） */
  let terminalReceived = false

  /**
   * 分发一个 SSE 事件（原样透传）。
   *
   * @param eventName 事件名
   * @param data      事件数据对象
   */
  const dispatch = (eventName: string, data: Record<string, unknown>): void => {
    if (!eventName) return
    if (eventName === 'result' || eventName === 'error' || eventName === 'done') {
      terminalReceived = true
    }
    handlers.onEvent({ event: eventName, data } as AgentsChatStreamEvent)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const parser = createSseEventParser()

  const pump = async (): Promise<void> => {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const messages = parser.push(decoder.decode(value, { stream: true }))
        for (const message of messages) {
          const payloadText = String(message.data || '').trim()
          if (!payloadText) continue
          try {
            dispatch(message.event, JSON.parse(payloadText) as Record<string, unknown>)
          } catch (error) {
            console.warn('[lensAgentChat] SSE 数据解析失败', error, payloadText.slice(0, 200))
          }
        }
      }
      const tailMessages = [
        ...parser.push(decoder.decode()),
        ...parser.finish(),
      ]
      for (const message of tailMessages) {
        const payloadText = String(message.data || '').trim()
        if (!payloadText) continue
        try {
          dispatch(message.event, JSON.parse(payloadText) as Record<string, unknown>)
        } catch (error) {
          console.warn('[lensAgentChat] SSE 尾部数据解析失败', error)
        }
      }
      if (!controller.signal.aborted && !terminalReceived) {
        handlers.onError?.(new Error('画布 Agent 对话在结束事件前中断，请重试'))
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        handlers.onError?.(error instanceof Error ? error : new Error('画布 Agent 对话读取失败'))
      }
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // 读取器已释放，忽略
      }
    }
  }

  void pump()

  return () => controller.abort()
}

/**
 * lens 对话非流式入口（与 tapcanvas 的 agentsChat 同签名）。
 *
 * <p>AiChatDialog 只使用流式接口；这里保留实现是为了避免 lens 画布内其它组件
 * 误调 tapcanvas 的 `/public/agents/chat`。</p>
 *
 * @param payload 对话请求
 * @returns 最终响应对象
 */
export async function lensAgentsChat(payload: AgentsChatRequestDto): Promise<AgentsChatResponseDto> {
  return new Promise<AgentsChatResponseDto>((resolve, reject) => {
    let settled = false
    void lensAgentsChatStream(payload, {
      onEvent: (event) => {
        if (settled) return
        if (event.event === 'result') {
          settled = true
          const responseBody = (event.data && typeof event.data === 'object' && 'response' in event.data)
            ? event.data.response as AgentsChatResponseDto
            : null
          if (responseBody) {
            resolve(responseBody)
          } else {
            reject(new Error('画布 Agent 结果事件缺少 response'))
          }
          return
        }
        if (event.event === 'error') {
          settled = true
          const message = (event.data && typeof event.data === 'object' && 'message' in event.data)
            ? String(event.data.message || '对话失败')
            : '对话失败'
          reject(new Error(message))
        }
      },
      onError: (error) => {
        if (settled) return
        settled = true
        reject(error)
      },
    }).catch((error: unknown) => {
      if (settled) return
      settled = true
      reject(error instanceof Error ? error : new Error('对话失败'))
    })
  })
}
