/**
 * Lens 后端 API 适配层（画布前端直连 lens 后端）
 *
 * - 读 cookie `Admin-Token`，加 `Authorization: Bearer` 头
 * - 解包 RuoYi AjaxResult{code,msg,data} / TableDataInfo{code,msg,total,rows}
 * - 全部复用 lens 现有接口，仅 flow 读写为新增（/api/canvas/*）
 */

/** 读 cookie（lens 的 Admin-Token 存在 cookie，同 host 共享） */
function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`))
  return match ? decodeURIComponent(match[1]) : null
}

/** 诊断时截取的最大响应体字符数（避免超长 body 灌进控制台与错误文案） */
const LENS_DIAG_BODY_MAX_CHARS = 500

/** 是否输出 lens 接口诊断日志（排查接口失败时保持开启；确认稳定后可置 false 关闭） */
const LENS_API_DEBUG = true

/**
 * lens 接口诊断日志统一出口。
 *
 * <p>集中一处便于整体开关，避免日志散落在各调用点无法收敛。
 *
 * @param level  日志级别（log=普通，error=异常）
 * @param message 日志标题
 * @param detail  结构化明细（URL、状态码、耗时、响应体等）
 */
function lensLog(level: 'log' | 'error', message: string, detail?: Record<string, unknown>): void {
  if (!LENS_API_DEBUG) return
  if (level === 'error') {
    console.error(message, detail === undefined ? '' : detail)
  } else {
    console.log(message, detail === undefined ? '' : detail)
  }
}

/**
 * 解析 lens 响应体并输出诊断日志。
 *
 * <p>原实现 `r.json().catch(() => ({}))` 有两个缺陷：
 * <ol>
 *   <li>响应不是 JSON（302 跳登录页返回 HTML、网关错误页、空 body）时被静默吞成 `{}`；</li>
 *   <li>从不检查 HTTP 状态码，`code !== 200` 且 `msg` 为空时只抛出无信息的「lens 接口失败」。</li>
 * </ol>
 * 结果是 302 / 非 JSON / 空响应 / 业务码非 200 四种完全不同的故障退化成同一句文案，
 * 无法定位是哪个接口、什么原因（违反「显式失败、禁止静默兜底」）。
 *
 * <p>这里改为先取原始文本再解析，异常时把 URL、HTTP 状态与响应体带进错误信息，
 * 并打印到控制台，保证失败可诊断。
 *
 * @param r         原始响应
 * @param url       请求地址（诊断用）
 * @param startedAt 请求发起时刻（用于计算耗时）
 * @returns 解析后的响应体
 */
async function parseLensResponse(r: Response, url: string, startedAt: number): Promise<Record<string, unknown>> {
  const costMs = Date.now() - startedAt
  const rawText = await r.text().catch(() => '')
  let body: Record<string, unknown>
  try {
    body = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : {}
  } catch {
    const detail = {
      url,
      httpStatus: r.status,
      costMs,
      rawText: rawText.slice(0, LENS_DIAG_BODY_MAX_CHARS),
    }
    lensLog('error', `[lens] ✗ 响应非 JSON  ${url}`, detail)
    throw new Error(`lens 接口返回非 JSON：HTTP ${r.status} url=${url} body=${rawText.slice(0, 200)}`)
  }
  if (body.code !== 200) {
    const msg = typeof body.msg === 'string' && body.msg.trim() ? body.msg : '(后端未返回 msg)'
    const detail = { url, httpStatus: r.status, costMs, code: body.code, msg: body.msg, body }
    lensLog('error', `[lens] ✗ 业务码非 200  ${url}`, detail)
    throw new Error(`lens 接口失败：HTTP ${r.status} code=${String(body.code)} msg=${msg} url=${url}`)
  }
  lensLog('log', `[lens] ✓ ${r.status} ${costMs}ms  ${url}`)
  return body
}

/**
 * lens 接口统一请求入口：发请求 → 记录诊断日志 → 解析响应体。
 *
 * <p>所有 lens 接口（lensFetch / lensFetchPage）都经此发起，因此日志天然覆盖全部接口，
 * 不需要在每个调用点单独埋点；调用方只负责把响应体解包成各自的返回结构。
 *
 * <p>额外覆盖网络层失败：CORS 被拒、连接被拒、断网时 fetch 会直接 reject，
 * 此时没有状态码也没有响应体，原实现只会抛出一句无信息的错误，这里显式记录原因。
 *
 * @param url  接口地址
 * @param opts fetch 选项
 * @returns 解析后的响应体（已确认 HTTP 可达且业务码为 200）
 */
async function lensRequest(url: string, opts?: RequestInit): Promise<Record<string, unknown>> {
  const startedAt = Date.now()
  const method = String(opts?.method || 'GET').toUpperCase()
  lensLog('log', `[lens] → ${method} ${url}`)

  const token = readCookie('Admin-Token')
  let r: Response
  try {
    r = await fetch(url, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(opts?.headers || {}),
      },
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    lensLog('error', `[lens] ✗ 请求未到达  ${method} ${url}`, {
      url,
      method,
      costMs: Date.now() - startedAt,
      hasToken: Boolean(token),
      reason,
    })
    throw new Error(`lens 接口请求失败：${method} url=${url} 原因=${reason}`)
  }
  return parseLensResponse(r, url, startedAt)
}

/**
 * 分页请求封装：保留 RuoYi TableDataInfo 的 total。
 *
 * <p>不能用 {@link lensFetch}：它在 `body.rows` 是数组时**直接返回 rows 数组**，
 * 会丢掉 total（分页就没了）。这里显式返回 `{ rows, total }`。
 *
 * @param url 接口地址
 * @param opts fetch 选项
 * @returns 列表 + 总数（字段缺失时归一为空数组 / 0，避免调用方读 .length 崩溃）
 */
async function lensFetchPage<T>(url: string, opts?: RequestInit): Promise<{ rows: T[]; total: number }> {
  const body = (await lensRequest(url, opts)) as {
    code?: number
    msg?: string
    total?: number
    rows?: unknown
  }
  return {
    rows: Array.isArray(body.rows) ? (body.rows as T[]) : [],
    total: typeof body.total === 'number' ? body.total : 0,
  }
}

/** 统一请求封装：带 lens token，解包 RuoYi 结构 */
async function lensFetch<T>(url: string, opts?: RequestInit): Promise<T> {
  const body = await lensRequest(url, opts) as { code?: number; msg?: string; data?: unknown; rows?: unknown }
  // TableDataInfo 返回 rows；AjaxResult 返回 data
  if (Array.isArray(body.rows)) return body.rows as T
  return (body.data ?? body) as T
}

/**
 * 请求返回「裸业务体」的 lens 接口（响应体无 RuoYi AjaxResult 包装）。
 *
 * <p>节点预设接口按画布契约直接返回业务体：GET 返回数组、POST 返回单个对象，
 * 均**不含 `code` 字段**。这类响应不能走 {@link lensFetch}
 * —— 它强制校验 `body.code === 200`，对裸数组/裸对象必然判定失败
 * （数组的 `code` 是 `undefined`，`undefined !== 200` 成立，于是抛出「lens 接口失败」）。
 *
 * <p>认证失败等异常路径仍由后端返回 AjaxResult（含 `code`），因此这里显式区分两种形态：
 * 有 `code` 就按业务码校验并取 `data`；没有 `code` 的才是成功的裸业务体。
 * 这是对两种已定义契约的显式分支，不是静默兜底 —— 既非数组也非带 `code` 的对象一律报错。
 *
 * @param url  接口地址
 * @param opts fetch 选项
 * @returns 裸业务体（数组或对象）
 */
async function lensFetchBare(url: string, opts?: RequestInit): Promise<unknown> {
  const startedAt = Date.now()
  const method = String(opts?.method || 'GET').toUpperCase()
  lensLog('log', `[lens] → ${method} ${url}`)

  const token = readCookie('Admin-Token')
  let r: Response
  try {
    r = await fetch(url, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(opts?.headers || {}),
      },
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    lensLog('error', `[lens] ✗ 请求未到达  ${method} ${url}`, {
      url,
      method,
      costMs: Date.now() - startedAt,
      hasToken: Boolean(token),
      reason,
    })
    throw new Error(`lens 接口请求失败：${method} url=${url} 原因=${reason}`)
  }

  const costMs = Date.now() - startedAt
  const rawText = await r.text().catch(() => '')
  let parsed: unknown
  try {
    parsed = rawText ? JSON.parse(rawText) : null
  } catch {
    lensLog('error', `[lens] ✗ 响应非 JSON  ${url}`, {
      url,
      httpStatus: r.status,
      costMs,
      rawText: rawText.slice(0, LENS_DIAG_BODY_MAX_CHARS),
    })
    throw new Error(`lens 接口返回非 JSON：HTTP ${r.status} url=${url} body=${rawText.slice(0, 200)}`)
  }

  // 形态一：AjaxResult 包装（认证失败 / 业务异常走这条）
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && 'code' in parsed) {
    const envelope = parsed as { code?: unknown; msg?: unknown; data?: unknown }
    if (envelope.code !== 200) {
      const msg = typeof envelope.msg === 'string' && envelope.msg.trim() ? envelope.msg : '(后端未返回 msg)'
      lensLog('error', `[lens] ✗ 业务码非 200  ${url}`, {
        url,
        httpStatus: r.status,
        costMs,
        code: envelope.code,
        msg: envelope.msg,
      })
      throw new Error(`lens 接口失败：HTTP ${r.status} code=${String(envelope.code)} msg=${msg} url=${url}`)
    }
    lensLog('log', `[lens] ✓ ${r.status} ${costMs}ms  ${url} (AjaxResult 包装)`)
    return envelope.data ?? envelope
  }

  // 形态二：裸业务体（数组 / 对象），没有 code 字段属正常契约
  if (parsed === null) {
    lensLog('error', `[lens] ✗ 响应体为空  ${url}`, { url, httpStatus: r.status, costMs })
    throw new Error(`lens 接口响应体为空：HTTP ${r.status} url=${url}`)
  }
  lensLog('log', `[lens] ✓ ${r.status} ${costMs}ms  ${url}`)
  return parsed
}

// ============ 类型定义（lens 实体 → 画布投影所需字段） ============

/** 集（选集下拉） */
export interface LensEpisodeBrief {
  episodeNumber: number
  title?: string
}

/** 分镜 */
export interface LensStoryboard {
  id: string
  storyboardOrder?: number
  scriptContent?: string
  shots?: string
  prompt?: string
  selectedImageUrl?: string
  /** 0=图 1=视频 */
  selectFileType?: number
  /** 时间段（如 下午/夜晚），非氛围 */
  timeOfDay?: string
  /** 氛围 */
  atmosphere?: string
  /** 分镜时长（秒） */
  time?: number
  line?: string
  speakerName?: string
  /** 0未生成 1生成中 2成功 3失败 4智能分析中 */
  videoStatus?: number
  /** 0未分析 1分析中 2成功 3失败 */
  analyzeState?: number
  /** 0未处理 1生成中 2成功 3失败 */
  lineArtStatus?: number
  sceneId?: string
  episodeNum?: number
}

/** 资产富查询（assetsByEpisode 返回，带 refId=分镜ID） */
export interface LensAssetEnriched {
  refId?: string
  assetCategory?: number
  assetId?: string
  roleId?: string
  characterName?: string
  cloneName?: string
  roleImg?: string
  frontImg?: string
  threeImg?: string
  imgName?: string
  imgUrl?: string
  imgState?: number
  hasHuman?: number
  description?: string
}

/** 剧本（content 原文 + scriptContent 台本） */
export interface LensScriptContent {
  content?: string
  scriptContent?: string
}

/** 画布编排（flow 读写） */
export interface LensCanvasFlow {
  id?: string
  dramaId?: string
  episodeNum?: number
  name?: string
  data?: string
  version?: number
  updateBy?: string
}

/** 角色（lensRole/list 返回） */
export interface LensRole {
  id: string
  roleName?: string
  prompt?: string
  img?: string
  frontImg?: string
  threeImg?: string
  roleType?: number
  parentId?: string
  cloneName?: string
}

/** 场景/道具资产（lensImage/listHistory 返回） */
export interface LensAssetImage {
  id: string
  name?: string
  url?: string
  prompt?: string
  type?: number
  parentId?: string
  variantName?: string
  hasHuman?: number
}

/**
 * 画布生图任务提交结果（/api/application/runTaskByCanvas 的 data 字段）。
 *
 * 画布节点没有 lens 资产身份（无 assetType/assetId），因此模型、比例、分辨率
 * 全部由后端从剧配置 style_config 推导，前端不下发 modelKey。
 */
export interface LensCanvasTaskSubmitResult {
  /** lens task_queue 主键，后续用 getCanvasTaskResult 轮询 */
  taskId: number
  /** 后端实际使用的应用ID（便于排查，前端不参与推导） */
  appId?: number
  /** 后端实际使用的渠道 */
  channel?: string
  /** 后端推导出的比例 */
  ratio?: string
  /** 后端推导出的分辨率 */
  resolution?: string
  /** 后端拼接出的完整提示词（便于前端核对） */
  fullPrompt?: string
  /** 是否识别到参考图（决定图生图/文生图） */
  hasReference?: boolean
  /** 实际使用的参考图 URL */
  refUrl?: string
}

/**
 * 画布生图任务提交入参。
 *
 * <p><b>可选参数一律「用户显式选择才传」</b>：画布侧节点数据里的模型/比例/尺寸/质量
 * 都有系统默认兜底写入，若不加区分地下发，会把默认值误当用户选择、覆盖后端从
 * 剧配置 style_config 推导的结果。因此调用方必须先判断用户的显式选择标记，
 * 未显式选择时不要传对应字段，交由后端推导。
 */
export interface LensCanvasTaskSubmitParams {
  /** 已拼好的完整提示词（保留画布侧角色卡约束、@别名、focus guide 等能力） */
  prompt: string
  /** 剧ID */
  dramaId: string
  /** 集数（后端定位任务所属集） */
  episodeNum?: number
  /** 参考图 URL 列表（可为空数组；非空即图生图） */
  refImages?: string[]
  /** 用户显式选择的生图应用ID（lens_application.id，即模型下拉的 value）；未选则不下发 */
  appId?: number
  /** 用户显式选择的画幅比例（如 "16:9"）；未选则不下发 */
  ratio?: string
  /** 用户显式选择的输出宽度（像素）；未选则不下发 */
  width?: number
  /** 用户显式选择的输出高度（像素）；未选则不下发 */
  height?: number
  /** 用户显式选择的质量档位；未选/空串则不下发，由渠道兜底 */
  quality?: string
  /** 画布节点ID（仅用于后端日志排查） */
  nodeId?: string
  /** 画布节点类型（仅用于后端日志排查） */
  nodeKind?: string
}

/** 任务记录（task/list 或 storyboardTask/list 返回） */
export interface LensTaskRecord {
  id?: string
  taskStatus?: string
  status?: string
  fileUrl?: string
  results?: string
  resMsg?: string
  errorMsg?: string
  prompt?: string
  channel?: string
  model?: string
}

// ============ 类型化函数（全部复用 lens 现有接口） ============

/** 集列表（选集下拉）。后端 getAllEpisode 返回纯整数数组 List<Integer>，这里适配成对象数组 */
export async function listEpisodes(dramaId: string): Promise<LensEpisodeBrief[]> {
  const list = await lensFetch<number[]>(`/api/episode/getAllEpisode?dramaId=${encodeURIComponent(dramaId)}`, { method: 'POST' })
  return list.map((episodeNumber) => ({ episodeNumber }))
}

/** 分镜列表 */
export async function listStoryboards(dramaId: string, episodeNum: number): Promise<LensStoryboard[]> {
  return lensFetch<LensStoryboard[]>(`/api/storyboard/listByEpisode?dramaId=${encodeURIComponent(dramaId)}&episodeNum=${episodeNum}`)
}

/** 资产列表（带 refId=分镜ID） */
export async function getEpisodeAssets(dramaId: string, episodeNum: number): Promise<LensAssetEnriched[]> {
  return lensFetch<LensAssetEnriched[]>('/api/storyboard/assetsByEpisode', {
    method: 'POST',
    body: JSON.stringify({ dramaId, episodeNum }),
  })
}

/** 剧本原文 + 台本（剧本原文走 /api/episode/novelContent，台本走 /api/episode/scriptContent） */
export async function getScriptContent(dramaId: string, episodeNum: number): Promise<LensScriptContent> {
  const [content, script] = await Promise.all([
    lensFetch<string>(`/api/episode/novelContent?dramaId=${encodeURIComponent(dramaId)}&episodeNum=${episodeNum}`),
    lensFetch<LensScriptContent>(`/api/episode/scriptContent?dramaId=${encodeURIComponent(dramaId)}&episodeNum=${episodeNum}`),
  ])
  return {
    content: typeof content === 'string' ? content : '',
    scriptContent: typeof script?.scriptContent === 'string' ? script.scriptContent : '',
  }
}

/** 全剧角色（主动加资产） */
export async function listRoles(dramaId: string): Promise<LensRole[]> {
  return lensFetch<LensRole[]>('/api/lensRole/list', {
    method: 'POST',
    body: JSON.stringify({ dramaId, pageNum: 1, pageSize: 200 }),
  })
}

/** 全剧场景/道具（主动加资产，type: 1=场景 2=道具） */
export async function listAssets(dramaId: string, type: 1 | 2): Promise<LensAssetImage[]> {
  return lensFetch<LensAssetImage[]>('/api/lensImage/listHistory', {
    method: 'POST',
    body: JSON.stringify({ dramaId, type, pageNum: 1, pageSize: 200 }),
  })
}

/** 读编排 */
export async function getFlow(dramaId: string, episodeNum: number): Promise<LensCanvasFlow | null> {
  return lensFetch<LensCanvasFlow | null>(`/api/canvas/${encodeURIComponent(dramaId)}/episode/${episodeNum}/flow`)
}

/** 保存编排（upsert + 乐观锁） */
export async function saveFlow(dramaId: string, episodeNum: number, payload: { name?: string; data: unknown; version?: number }): Promise<LensCanvasFlow> {
  return lensFetch<LensCanvasFlow>(`/api/canvas/${encodeURIComponent(dramaId)}/episode/${episodeNum}/flow`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

/** 剧的风格配置（角色/场景生图、分镜生视频风格） */
export async function getStyleConfig(dramaId: string): Promise<Record<string, unknown> | null> {
  return lensFetch<Record<string, unknown> | null>('/api/sysApi/baseConfig/list', {
    method: 'POST',
    body: JSON.stringify({ pkg: String(dramaId), type: 'style_config' }),
  })
}

/** lens 模型条目（/api/model/* 返回 data 数组元素） */
export interface LensModelOption {
  value: string | number
  label?: string
  channel?: string
  channelType?: string
  forType?: string
  type?: string
  /** toModelJson 输出：模型自身启用标记 */
  enable?: boolean
  /** buildResult 合并的勾选状态（海外渠道需显式勾选才为 true） */
  enabled?: boolean
  needDuration?: boolean
  unitConsume?: number
  consumeType?: string
  resolutions?: string[]
  /**
   * 模型扩展参数（后端 toModelJson 下发，经 OthersFilterUtil 白名单过滤）。
   * qualities 为该模型支持的质量档位（多选：medium/high/xhigh/max），
   * 未配置或空数组表示该模型不支持质量选择。
   */
  others?: LensModelOthers
}

/** 模型扩展参数（qualities 为质量档位白名单，supportedRatios 为支持的画幅） */
export interface LensModelOthers {
  /** 支持的质量档位（多选）；空数组或未配置表示不支持质量选择 */
  qualities?: string[]
  /** 存量单值质量档位（兼容旧数据） */
  quality?: string
  /** 模型支持的画幅列表 */
  supportedRatios?: string[]
  /** 其余白名单字段保留为未知类型，避免误用未声明字段 */
  [key: string]: unknown
}

/** 生图模型列表 */
export async function getImageModels(): Promise<LensModelOption[]> {
  return lensFetch<LensModelOption[]>('/api/model/image')
}

/** 图生图模型列表 */
export async function getImage2ImageModels(): Promise<LensModelOption[]> {
  return lensFetch<LensModelOption[]>('/api/model/image2image')
}

/** 视频模型列表 */
export async function getVideoModels(): Promise<LensModelOption[]> {
  return lensFetch<LensModelOption[]>('/api/model/video')
}

/** 分镜视频模型列表 */
export async function getShotVideoModels(): Promise<LensModelOption[]> {
  return lensFetch<LensModelOption[]>('/api/model/shot_video')
}

/** 角色/场景/道具生图任务查询（任务结果展开） */
export async function listImageTasks(dramaId: string, episodeNum: number): Promise<LensTaskRecord[]> {
  return lensFetch<LensTaskRecord[]>('/api/task/list', {
    method: 'POST',
    body: JSON.stringify({ dramaId, episodeNum, pageNum: 1, pageSize: 50 }),
  })
}

/** 分镜生视频任务查询（任务结果展开） */
export async function listShotVideoTasks(dramaId: string, episodeNum: number): Promise<LensTaskRecord[]> {
  return lensFetch<LensTaskRecord[]>('/api/storyboardTask/list', {
    method: 'POST',
    body: JSON.stringify({ dramaId, episodeNum, pageNum: 1, pageSize: 50 }),
  })
}

/** 提交分镜生视频任务（/api/storyboardTask/submit，与 lens 分镜板一致） */
export async function submitShotVideo(params: Record<string, unknown>): Promise<unknown> {
  return lensFetch<unknown>('/api/storyboardTask/submit', {
    method: 'POST',
    body: JSON.stringify(params),
  })
}

/** 编辑分镜（脚本/台词/说话者等，与 lens 分镜板一致走 /api/storyboard/edit） */
export async function editStoryboard(patch: Record<string, unknown>): Promise<unknown> {
  return lensFetch<unknown>('/api/storyboard/edit', {
    method: 'POST',
    body: JSON.stringify(patch),
  })
}

/** 清空分镜说话者（speakerName 置空，与 lens 分镜板一致） */
export async function clearStoryboardSpeaker(id: string, dramaId: string): Promise<unknown> {
  return lensFetch<unknown>('/api/storyboard/clearSpeakerName', {
    method: 'POST',
    body: JSON.stringify({ id, dramaId }),
  })
}

// ============ 画布生图链路（lens 模式下 image / imageEdit 节点的唯一出口） ============

/**
 * 提交画布生图任务。
 *
 * <p>与角色/场景资产生图（{@link listImageTasks} 那套）的关键区别：<b>画布节点没有
 * lens 资产身份</b>（无 assetType/assetId/storyboardIds）。因此调用方必须不传这三项，
 * 否则后端会把画布产出回写到角色图或某个分镜的 selectedImageUrl 上，污染用户数据。
 *
 * <p>模型与分辨率由后端从剧配置推导，前端不下发 modelKey。
 *
 * @param params 提示词、剧ID 与参考图
 * @returns 后端提交结果（含 taskId，用于后续轮询）
 */
export async function runTaskByCanvas(params: LensCanvasTaskSubmitParams): Promise<LensCanvasTaskSubmitResult> {
  const payload: Record<string, unknown> = {
    prompt: params.prompt,
    dramaId: params.dramaId,
  }
  if (typeof params.episodeNum === 'number' && Number.isFinite(params.episodeNum)) {
    payload.episodeNum = Math.trunc(params.episodeNum)
  }
  // 参考图：后端同时兼容 [{url}] 与 ["url"]，这里统一成对象数组（标准形态）
  if (Array.isArray(params.refImages) && params.refImages.length) {
    payload.refImages = params.refImages.map((url) => ({ url }))
  }
  // 以下字段只在用户显式选择时下发：未传即由后端从剧配置推导
  if (typeof params.appId === 'number' && Number.isFinite(params.appId)) {
    payload.appId = params.appId
  }
  if (typeof params.ratio === 'string' && params.ratio.trim()) {
    payload.ratio = params.ratio.trim()
  }
  if (typeof params.width === 'number' && Number.isFinite(params.width)) {
    payload.width = Math.trunc(params.width)
  }
  if (typeof params.height === 'number' && Number.isFinite(params.height)) {
    payload.height = Math.trunc(params.height)
  }
  if (typeof params.quality === 'string' && params.quality.trim()) {
    payload.quality = params.quality.trim()
  }
  if (params.nodeId) payload.nodeId = params.nodeId
  if (params.nodeKind) payload.nodeKind = params.nodeKind

  const data = await lensFetch<LensCanvasTaskSubmitResult>('/api/application/runTaskByCanvas?as=lens', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  if (typeof data?.taskId !== 'number' || !Number.isFinite(data.taskId)) {
    throw new Error('lens 生图任务提交失败：响应未返回合法 taskId')
  }
  return data
}

/** lens task_queue 状态枚举的 name（对应后端 com.zsapps.api.enums.TaskQueueStatusEnum） */
export type LensTaskQueueStatus = 'CREATE' | 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'FAILED'

/** 画布任务状态查询结果（/api/taskQueue/status 的 data 字段） */
export interface LensCanvasTaskStatus {
  /** task_queue 主键 */
  taskId: number
  /** 任务状态（后端枚举 name） */
  status: LensTaskQueueStatus
  /** 成功时的产出文件 URL（图片），未成功时为空 */
  fileUrl?: string | null
  /** 失败原因 */
  resMsg?: string | null
  /** 备注（失败时后端会把失败原因放这里） */
  remark?: string | null
}

/** 合法状态集合：用于对未知状态做显式拒绝，不做隐式兜底 */
const LENS_TASK_QUEUE_STATUSES: readonly LensTaskQueueStatus[] = [
  'CREATE',
  'QUEUED',
  'RUNNING',
  'SUCCESS',
  'FAILED',
]

/**
 * 查询单个画布任务的执行状态与结果。
 *
 * <p>按 taskId 精确查询，**不使用** {@code getEpisodeTaskStatus}：后者取的是 Redis 里
 * 「该集最新拆分镜任务」的 ID，会造成任务张冠李戴。
 *
 * @param taskId task_queue 主键
 * @returns 任务状态与成功时的产出 URL
 */
export async function getCanvasTaskStatus(taskId: number): Promise<LensCanvasTaskStatus> {
  const data = await lensFetch<LensCanvasTaskStatus>(
    `/api/taskQueue/status?taskId=${encodeURIComponent(String(taskId))}`,
  )
  if (typeof data?.taskId !== 'number' || !Number.isFinite(data.taskId)) {
    throw new Error('lens 任务状态查询失败：响应未返回合法 taskId')
  }
  // 显式拒绝未知状态，禁止兜底成「继续轮询」或「成功」
  if (!LENS_TASK_QUEUE_STATUSES.includes(data.status)) {
    throw new Error(`lens 任务状态查询失败：未知任务状态 ${String(data.status)}`)
  }
  return data
}

/** 从 lens 已有身份接口读取真实管理员角色，不使用 TapCanvas 开发环境权限。 */
export async function getLensCurrentUserIsAdmin(): Promise<boolean> {
  const info = await lensFetch<{ roles?: unknown }>('/api/getInfo')
  if (!Array.isArray(info.roles)) throw new Error('身份接口未返回角色列表')
  return info.roles.includes('admin')
}

/** lens 提示词润色的计费结果（后端 chargePromptPolish 返回体）。 */
export interface LensPromptPolishBilling {
  /** 本次是否走免费额度（true 表示未扣积分） */
  free: boolean
  /** 今日已使用次数（含本次） */
  freeUsed: number
  /** 每日免费次数上限（后台可配，最大 10） */
  freeLimit: number
  /** 今日剩余免费次数 */
  freeRemain: number
  /** 本次实际扣减的积分数（免费时为 0） */
  charged: number
}

/** lens 提示词润色结果。 */
export interface LensPromptPolishResult {
  /** 润色后的文本 */
  polishedText: string
  /** 计费信息；后端未返回时为 null（不阻断润色结果的使用） */
  billing: LensPromptPolishBilling | null
}

/** 提示词润色入参。 */
export interface LensPromptPolishParams {
  /** 待润色的文本，必填 */
  prompt: string
  /** 调用方补充的系统提示词（可选） */
  systemPrompt?: string
  /** 模型别名（可选；后端数据源池已配 model 时以池为准） */
  modelAlias?: string
}

/**
 * 提示词润色（lens 后端同步接口）。
 *
 * <p>背景：画布原先直连 TapCanvas 的 `POST /public/tasks`（kind=prompt_refine），
 * 但 lens 部署下 `VITE_API_BASE` 指向 9096，而 lens 没有该路由 —— 请求被 302 到 `/`
 * 后返回 HTML 200，前端 content-type 守卫抛「接口返回 HTML 而非 JSON」。
 * 本函数改为调用 lens 自己的润色接口，由后端按「提示词设置 → 智能分析」配置的数据源池
 * （主 → 备1 → 备2）执行润色，成功后才扣积分。
 *
 * @param params 润色入参（prompt / systemPrompt / modelAlias）
 * @returns 润色文本与计费信息
 */
export async function polishPrompt(params: LensPromptPolishParams): Promise<LensPromptPolishResult> {
  const prompt = typeof params.prompt === 'string' ? params.prompt.trim() : ''
  if (!prompt) {
    throw new Error('缺少待润色的提示词')
  }
  const body: Record<string, unknown> = { prompt }
  if (params.systemPrompt) body.systemPrompt = params.systemPrompt
  if (params.modelAlias) body.modelAlias = params.modelAlias

  const data = await lensFetch<{ polishedText?: unknown; billing?: unknown }>('/api/canvas/promptPolish', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  // 显式失败：后端必须返回非空 polishedText，拿不到就直接报错，不做任何兜底
  const polishedText = typeof data?.polishedText === 'string' ? data.polishedText.trim() : ''
  if (!polishedText) {
    throw new Error('提示词润色失败：接口未返回有效内容')
  }
  return { polishedText, billing: normalizeLensPromptPolishBilling(data?.billing) }
}

/**
 * 归一化润色计费信息：字段缺失或类型不符时整块返回 null（由调用方决定是否展示），
 * 不做逐字段补默认值 —— 避免把「后端没返回」伪装成「免费 0 次」误导用户。
 *
 * @param raw 后端返回的 billing 字段
 * @returns 计费信息，形状不合法时返回 null
 */
function normalizeLensPromptPolishBilling(raw: unknown): LensPromptPolishBilling | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const toNumber = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null
  const freeUsed = toNumber(record.freeUsed)
  const freeLimit = toNumber(record.freeLimit)
  const freeRemain = toNumber(record.freeRemain)
  const charged = toNumber(record.charged)
  if (freeUsed === null || freeLimit === null || freeRemain === null || charged === null) return null
  return {
    free: record.free === true,
    freeUsed,
    freeLimit,
    freeRemain,
    charged,
  }
}
