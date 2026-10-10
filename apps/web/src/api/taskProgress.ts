import { API_BASE, type TaskAssetDto, type TaskKind, type TaskStatus } from './server'

export interface TaskProgressEventMessage {
  nodeId?: string
  nodeKind?: string
  taskId?: string
  taskKind?: TaskKind
  vendor?: string
  status: TaskStatus
  progress?: number
  message?: unknown
  assets?: TaskAssetDto[]
  raw?: any
  timestamp?: number
}

interface SubscribeOptions {
  url?: string
  token: string
  onEvent: (event: TaskProgressEventMessage) => void
  onOpen?: () => void
  onError?: (error: Error) => void
}

function resolveStreamUrl(path?: string) {
  const trimmed = (path || '').trim()
  if (!trimmed) {
    return `${API_BASE.replace(/\/$/, '')}/tasks/stream`
  }
  if (/^https?:/i.test(trimmed)) return trimmed
  if (trimmed.startsWith('/')) {
    return `${API_BASE.replace(/\/$/, '')}${trimmed}`
  }
  return `${API_BASE.replace(/\/$/, '')}/${trimmed}`
}

export function subscribeTaskProgress({ url, token, onEvent, onOpen, onError }: SubscribeOptions) {
  if (!token) return () => {}
  const resolvedUrl = resolveStreamUrl(url)
  const controller = new AbortController()

  const connect = async () => {
    const response = await fetch(resolvedUrl, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    })

    // 错误信息必须带实际请求 URL：该链路曾被配置成打向不存在该路由的后端，
    // 只报状态码无法定位是哪个地址失败。
    if (!response.ok) {
      throw new Error(`task progress stream failed: ${response.status} url=${resolvedUrl}`)
    }
    if (!response.body) {
      throw new Error(`task progress stream missing body url=${resolvedUrl}`)
    }
    // 显式校验响应确实是 SSE。
    // 服务端无此路由时会被安全框架 302 到登录页，fetch 默认跟随重定向拿到 HTML，
    // 此时 response.ok 为 true，若不校验 content-type 会把 HTML 当事件流静默空转，
    // 既不报错也收不到任何事件（禁止静默兜底：非 SSE 响应直接失败）。
    const contentType = String(response.headers.get('content-type') || '').toLowerCase()
    if (!contentType.includes('text/event-stream')) {
      throw new Error(
        `task progress stream returned non-SSE response: content-type=${contentType || '(empty)'} url=${resolvedUrl}`,
      )
    }

    onOpen?.()

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let separator = buffer.indexOf('\n\n')
        while (separator !== -1) {
          const rawChunk = buffer.slice(0, separator)
          buffer = buffer.slice(separator + 2)
          const cleaned = rawChunk.replace(/\r/g, '')
          const dataLines = cleaned
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.startsWith('data:'))
            .map(line => line.replace(/^data:\s*/i, ''))
          dataLines.forEach((payload) => {
            if (!payload || payload === '[DONE]') return
            try {
              onEvent(JSON.parse(payload))
            } catch (err) {
              console.warn('[task-progress] invalid payload', err)
            }
          })
          separator = buffer.indexOf('\n\n')
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  connect().catch((err) => {
    if (!controller.signal.aborted) {
      console.error('task progress stream error', err)
      onError?.(err instanceof Error ? err : new Error('task progress stream error'))
    }
  })

  return () => controller.abort()
}
