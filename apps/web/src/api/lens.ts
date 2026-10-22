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
 * 把 lens 接口错误文案转换成面向用户的简短原因。
 *
 * <p>接口层抛出的消息为了可诊断，带上了请求方法、接口地址、业务码等信息，
 * 例如 `lens 接口请求失败：POST url=/api/canvas/738/episode/1/flow 原因=Failed to fetch`。
 * 这些细节只该进控制台日志；直接展示在页面顶部会把内部接口路径暴露给用户。
 * 因此这里只提取真正的失败原因：
 * <ul>
 *   <li>请求未到达：取 `原因=` 之后的内容，如 `Failed to fetch`；</li>
 *   <li>业务码失败：取 `msg=` 与结尾 ` url=` 之间的后端提示；</li>
 *   <li>其它错误（非 JSON / 响应体为空等）原样返回，避免丢失排查线索。</li>
 * </ul>
 *
 * @param err 捕获到的异常（通常来自 lensRequest / lensFetch）
 * @returns 面向用户展示的失败原因
 */
export function lensErrorReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  const reasonIndex = message.indexOf('原因=')
  if (reasonIndex >= 0) {
    const reason = message.slice(reasonIndex + '原因='.length).trim()
    if (reason) return reason
  }
  const msgIndex = message.indexOf(' msg=')
  if (msgIndex >= 0) {
    const urlIndex = message.lastIndexOf(' url=')
    const reason = message.slice(msgIndex + ' msg='.length, urlIndex > msgIndex ? urlIndex : undefined).trim()
    if (reason) return reason
  }
  return message
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
  /**
   * 父级ID（语义按 assetCategory 区分）：
   * - assetCategory=1（角色）：分身的父角色ID，非分身时为 null
   * - assetCategory=2,3,4（场景/道具/站位）：父场景ID，非子场景时为 null
   *
   * 画布据此建立「主角色 → 分身」「主场景 → 子场景」的派生关系与分组合并。
   */
  parentId?: string
  roleImg?: string
  frontImg?: string
  threeImg?: string
  imgName?: string
  imgUrl?: string
  /** 子场景特征名（仅子场景有值，如"夜"） */
  variantName?: string
  /** 子场景分类：time/weather/inout/area/position/furniture/facility */
  subType?: string
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
  subType?: string
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
  /** 用户显式选择的分辨率档位，按当前模型配置原值下发。 */
  resolution?: string
  /** 用户显式选择的质量档位；未选/空串则不下发，由渠道兜底 */
  quality?: string
  /** 画布节点ID（仅用于后端日志排查） */
  nodeId?: string
  /** 画布节点类型（仅用于后端日志排查） */
  nodeKind?: string
  /**
   * 画布编排ID（lens_canvas_flow.id）。
   *
   * <p>自由节点的任务归属必传：写入 task_queue.scene_id，用于隔离不同画布。
   * 不同 flow 的节点编号可能重复，只靠节点ID会把任务串到一起。
   */
  canvasFlowId?: number
  /**
   * 画布节点数字ID。
   *
   * <p>自由节点的任务归属必传：写入 task_queue.asset_id，用于把任务结果精确匹配回该节点。
   * 需由前端在 flow 数据里持久化（见 CanvasFreeNodeAssetId），保证刷新后不变。
   *
   * <p><b>业务投影节点（角色/场景/道具）不得传</b>：它们用 assetType/assetId 定位。
   */
  canvasNodeAssetId?: number
  /**
   * 业务资产类型：0=角色 1=场景 2=道具。
   *
   * <p>业务投影节点必传，与 assetId 一起写入 task_queue，
   * 使任务能被对应业务面板按真实资产ID查到。自由节点不传。
   */
  assetType?: number
  /**
   * 业务资产ID（真实 lens 资产主键）。
   *
   * <p>业务投影节点必传。按字符串下发，避免 Long 主键在 Number 转换时丢精度。
   */
  assetId?: string
}

/**
 * 任务记录（task/list 或 storyboardTask/list 返回）。
 *
 * <p>两个接口的字段名有差异，这里都声明为可选，由展示层归一化：
 * 生图任务（lens_application_task）用 {@code taskStatus/fileUrl/resMsg/submitter/moduleName}；
 * 分镜生视频任务（lens_storyboard_task）用 {@code status/results/errorMsg/userName/model} 等。
 */
export interface LensTaskRecord {
  /** 任务ID */
  id?: string
  /** 状态（生图任务字段名） */
  taskStatus?: string
  /** 状态（分镜生视频任务字段名） */
  status?: string
  /** 结果图 URL（多张以逗号分隔） */
  fileUrl?: string
  /** 结果 JSON 数组（含 type/url/thumbnail） */
  results?: string
  /** 失败原因（生图任务字段名） */
  resMsg?: string
  /** 失败原因（分镜生视频任务字段名） */
  errorMsg?: string
  /** 提示词 */
  prompt?: string
  /** 渠道 */
  channel?: string
  /** 模型名（分镜生视频任务） */
  model?: string
  /** 模型名（生图任务，映射自 lens_application.module_name） */
  moduleName?: string
  /** 用户选择的原始应用ID，用于匹配模型列表的应用显示名。 */
  originAppId?: string | number
  /** 提交人（生图任务） */
  submitter?: string
  /** 提交人用户名（分镜生视频任务） */
  userName?: string
  /** 提交人用户名（角色/场景/道具/自由节点任务，LensApplicationTask.createUserName） */
  createUserName?: string
  /** 分镜号（分镜生视频任务） */
  storyboardOrder?: number
  /** 时长（秒） */
  duration?: string | number
  /** 创建时间 */
  createTime?: string
  /** 完整请求参数 JSON（分镜生视频任务字段名） */
  taskParams?: string
  /**
   * 完整请求参数 JSON（角色/场景/道具/自由节点任务字段名）。
   *
   * <p>{@code /api/task/list} 返回的是 {@code LensApplicationTask}，没有 {@code taskParams}，
   * 完整请求体叫 {@code reqPar}（后端各渠道 handler 用 {@code taskQueue.taskParams} 写入）。
   * 参考图与画幅都藏在这个 JSON 里。
   */
  reqPar?: string
  /** 参考图（可能为 JSON 字符串或数组） */
  referenceImages?: string | string[]
  /** Ultra 模式标识：序列任务ID 非空即 ultra 链路 */
  seqJobId?: string
  /** 任务归属：画布编排ID（task_queue.scene_id，自由节点任务是画布flowId） */
  sceneId?: number | string
  /** 任务归属：资产类型（0=角色 1=场景 2=道具 10=画布自由节点） */
  assetType?: number
  /** 任务归属：资产ID（业务资产是真实主键，自由节点是节点数字ID） */
  assetId?: number | string
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

/** 按分镜板契约分页读取完整资产，避免父子资产跨页丢失。 */
export async function listReferenceAssets<T extends LensRole | LensAssetImage>(dramaId: string, category: 1 | 2 | 3): Promise<T[]> {
  // 角色接口不分页，默认仅查主身份；与分镜板一致，独立查询全部子造型。
  if (category === 1) {
    const [roles, clones] = await Promise.all([
      lensFetch<T[]>('/api/lensRole/list', { method: 'POST', body: JSON.stringify({ dramaId, allRole: 1 }) }),
      lensFetch<T[]>('/api/lensRole/list', { method: 'POST', body: JSON.stringify({ dramaId, roleType: 1 }) }),
    ])
    return [...roles, ...clones]
  }
  const pageSize = 100
  const rows: T[] = []
  for (let pageNum = 1; ; pageNum += 1) {
    const page = await lensFetchPage<T>('/api/lensImage/listHistory', {
      method: 'POST', body: JSON.stringify({ dramaId, pageNum, pageSize, type: category - 1 }),
    })
    rows.push(...page.rows)
    if (rows.length >= page.total || page.rows.length === 0) return rows
  }
}

/** 只追加分镜资产关联；权限与并发去重交给现有业务接口。 */
export async function addShotReferenceRelations(dramaId: string, storyboardId: string, addRelations: { assetId: string; assetCategory: number }[]): Promise<void> {
  await lensFetch<unknown>('/api/storyboard/saveRelations', { method: 'POST', body: JSON.stringify({ dramaId, storyboardId, addRelations }) })
}

/** 删除分镜资产关联，失败时保留画布引用与连线。 */
export async function removeShotReferenceRelations(dramaId: string, storyboardId: string, removeRelations: { assetId: string; assetCategory: number }[]): Promise<void> {
  await lensFetch<unknown>('/api/storyboard/removeRelations', { method: 'POST', body: JSON.stringify({ dramaId, storyboardId, removeRelations }) })
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
  /**
   * 剧配置页设置的默认模型标记。
   *
   * <p>由后端 markDefault() 按 Redis 中配置的默认模型 value 打标；
   * 未配置默认模型时后端不输出该字段，前端据此回退到列表第一个模型。
   */
  isDefault?: boolean
  /** buildResult 合并的勾选状态（海外渠道需显式勾选才为 true） */
  enabled?: boolean
  needDuration?: boolean
  unitConsume?: number
  consumeType?: number
  /** 后端计费器解析的每次／每秒单价，不在画布重复维护计费倍率。 */
  creditPricing?: { perSecond: boolean; cost: number; resolutionPrices: Record<string, number> } | null
  resolutions?: string[]
  /** 各分辨率对应积分，由 Lens 模型管理配置返回。 */
  resolutionPrices?: Record<string, number>
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

/**
 * 画布自由节点的资产类型（后端 AssetType.CANVAS_NODE）。
 *
 * <p>与 0=角色 1=场景 2=道具 隔开，用于把画布任务与真实资产生图任务区分开。
 * 该类型不做资产回填（自由节点没有对应的业务表记录）。
 */
export const CANVAS_NODE_ASSET_TYPE = 10

/** 画布任务结果查询参数（任务结果展开） */
export interface LensTaskQueryParams {
  /** 剧ID，用于后端权限校验（非管理员必须传，否则只能查到自己提交的任务） */
  dramaId: string
  /**
   * 画布自由节点的归属三元组之一：画布 flowId。
   *
   * <p>后端写入 task_queue.scene_id，用于隔离不同画布。
   */
  sceneId?: number
  /** 资产类型：10=画布自由节点 */
  assetType?: number
  /**
   * 画布节点数字ID。
   *
   * <p>后端写入 task_queue.asset_id，传了就只查该节点的任务；
   * 不传则查该画布（sceneId）下所有自由节点的任务。
   */
  assetId?: string | number
  /**
   * 画布节点数字ID集合（批量）。
   *
   * <p>一个来源节点可能衍生多个自由节点，逐个 assetId 查询会发 N 次请求；
   * 传本字段时后端按 {@code task_queue.asset_id IN (...)} 一次查完，
   * 调用方再按返回行的 assetId 自行分组。与 {@link assetId} 互斥使用。
   */
  assetIds?: Array<string | number>
  pageNum?: number
  pageSize?: number
}

/** 任务结果分页返回（后端 TableDataInfo 结构） */
export interface LensTaskPage {
  /** 任务记录列表 */
  rows: LensTaskRecord[]
  /** 总条数（用于分页） */
  total: number
}

/**
 * 当前用户是否可查看任务请求参数（对齐 lens 分镜板的 canViewParams）。
 *
 * <p>后端 `/api/system/user/canViewParams` 返回布尔；非 admin 或权限不足时为 false。
 * 接口异常时返回 false（不静默放行）——「查看参数」属敏感能力，失败必须收紧。
 *
 * @returns 可查看返回 true
 */
export async function canViewTaskParams(): Promise<boolean> {
  const startedAt = Date.now()
  const url = '/api/system/user/canViewParams'
  const token = readCookie('Admin-Token')
  lensLog('log', `[lens] → GET ${url}`)
  let r: Response
  try {
    r = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    lensLog('error', `[lens] ✗ 请求未到达  GET ${url}`, {
      url,
      costMs: Date.now() - startedAt,
      hasToken: Boolean(token),
      reason,
    })
    return false
  }
  const rawText = await r.text().catch(() => '')
  let body: { code?: number; data?: unknown }
  try {
    body = rawText ? (JSON.parse(rawText) as { code?: number; data?: unknown }) : {}
  } catch {
    lensLog('error', `[lens] ✗ 响应非 JSON  ${url}`, {
      url,
      httpStatus: r.status,
      costMs: Date.now() - startedAt,
      rawText: rawText.slice(0, LENS_DIAG_BODY_MAX_CHARS),
    })
    return false
  }
  const allowed = body.code === 200 && body.data === true
  lensLog(allowed ? 'log' : 'error', `[lens] ${allowed ? '✓' : '✗'} ${r.status} ${Date.now() - startedAt}ms  ${url}`, {
    url,
    httpStatus: r.status,
    code: body.code,
    data: body.data,
  })
  return allowed
}

/**
 * 查询画布自由节点的生图任务（任务结果展开）。
 *
 * <p>后端返回的是 TableDataInfo 分页结构（{@code { rows, total }}），不是裸数组，
 * 因此这里显式解包 —— 直接按数组解析会拿到空结果。
 *
 * <p>传 {@code assetId} 可精确到单个自由节点；不传则返回该画布下全部自由节点任务，
 * 由调用方按 {@code assetId} 自行分组匹配。
 *
 * @param params 剧ID、画布 flowId（sceneId）、资产类型与可选节点ID
 * @returns 任务列表 + 总数
 */
export async function listCanvasFreeNodeTasks(params: LensTaskQueryParams): Promise<LensTaskPage> {
  const body: Record<string, unknown> = {
    dramaId: params.dramaId,
    pageNum: params.pageNum ?? 1,
    pageSize: params.pageSize ?? 20,
  }
  if (params.sceneId !== undefined) body.sceneId = String(params.sceneId)
  if (params.assetType !== undefined) body.assetType = params.assetType
  if (params.assetId !== undefined) body.assetId = String(params.assetId)
  // 批量模式：后端 mapper 用 asset_id IN (...) 一次查完多个画布节点
  if (params.assetIds !== undefined) {
    if (!params.assetIds.length) {
      // 空数组会被后端当成“不传”，从而退化为查整张画布；这里显式返回空，避免误查
      return { rows: [], total: 0 }
    }
    body.assetIds = params.assetIds.map((id) => String(id))
  }

  return lensFetchPage<LensTaskRecord>('/api/task/list', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** 资产生图任务状态筛选，与 /api/task/list 的 taskStatus 字段一致。 */
export enum LensAssetTaskStatus {
  All = '',
  Created = 'CREATE',
  Queued = 'QUEUED',
  Running = 'RUNNING',
  Success = 'SUCCESS',
  Failed = 'FAILED',
}

/** 资产任务专用查询，始终携带自身ID；不使用分镜任务接口或画布自由节点归属。 */
export async function listAssetImageTasks(params: {
  dramaId: string; assetId: string; assetType: number; applicationIds: string[]
  pageNum: number; pageSize: number; taskStatus: LensAssetTaskStatus
}): Promise<LensTaskPage> {
  if (!params.dramaId || !params.assetId || !params.applicationIds.length) {
    throw new Error('缺少剧ID、资产ID或可用生图应用，无法查询资产任务')
  }
  return lensFetchPage<LensTaskRecord>('/api/task/list', {
    method: 'POST',
    body: JSON.stringify({ ...params, assetType: String(params.assetType), keyword: '', episodeNum: '',
      taskStatusNot: params.taskStatus ? LensAssetTaskStatus.All : LensAssetTaskStatus.Failed }),
  })
}

/** 角色/场景/道具生图任务查询（任务结果展开） */
export async function listImageTasks(dramaId: string, episodeNum: number): Promise<LensTaskPage> {
  return lensFetchPage<LensTaskRecord>('/api/task/list', {
    method: 'POST',
    body: JSON.stringify({ dramaId, episodeNum, pageNum: 1, pageSize: 50 }),
  })
}

/** 分镜生视频任务查询参数 */
export interface LensShotVideoTaskQueryParams {
  /** 剧ID（后端权限校验用） */
  dramaId: string
  /** 分镜ID：按单个分镜过滤（不传则返回该剧全部，量很大，务必传） */
  storyboardId?: string
  /** 集数（可选，与 storyboardId 同时传时取交集） */
  episodeNum?: number
  pageNum?: number
  pageSize?: number
}

/**
 * 分镜生视频任务查询（任务结果展开）。
 *
 * <p>后端返回 TableDataInfo 分页结构（{@code { rows, total }}），必须显式解包：
 * 之前直接返回原值会让调用方拿到 {@code undefined} 的 rows，
 * 渲染时读 {@code records.length} 直接抛 TypeError。
 *
 * <p>后端按 {@code storyboardId} 过滤单个分镜（见 StoryboardTaskController#list），
 * 因此不传 storyboardId 会返回该剧全部任务，调用方务必传入。
 *
 * @param params 剧ID、分镜ID 与分页
 * @returns 任务列表 + 总数
 */
export async function listShotVideoTasks(params: LensShotVideoTaskQueryParams): Promise<LensTaskPage> {
  const body: Record<string, unknown> = {
    dramaId: params.dramaId,
    pageNum: params.pageNum ?? 1,
    pageSize: params.pageSize ?? 20,
  }
  if (params.storyboardId) body.storyboardId = params.storyboardId
  if (params.episodeNum !== undefined) body.episodeNum = params.episodeNum

  return lensFetchPage<LensTaskRecord>('/api/storyboardTask/list', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** 采纳结果的媒体类型（与 lens_storyboard.select_file_type 同口径） */
export type LensShotFileType = 0 | 1

/** 采纳结果入参（对齐 lens 分镜板 submitToStoryboard 的 addForceSet 调用） */
export interface LensAdoptShotResultParams {
  /** 目标分镜ID（lens_storyboard.id） */
  storyboardId: string
  /** 结果媒体 URL（图或视频的原始地址） */
  url: string
  /** 媒体类型：0=图 1=视频（后端写入 select_file_type） */
  uploadType: LensShotFileType
}

/**
 * 采纳结果到分镜（/api/image/addForceSet）。
 *
 * <p>后端 {@code ImageLogic.insertLensImageForceSet} 会插入 lens_image，
 * 并把分镜的 selectedImageUrl / selectedImageId / selectFileType 更新为该结果
 * （与 lens 分镜板 `submitToStoryboard` 完全同一出口，不新增平行链路）。
 *
 * <p>失败必须显式抛出：本函数不做任何兜底，由调用方 toast 并保留原始原因。
 *
 * @param params 分镜ID、结果 URL 与媒体类型
 */
export async function adoptShotResult(params: LensAdoptShotResultParams): Promise<void> {
  await lensFetch<unknown>('/api/image/addForceSet', {
    method: 'POST',
    body: JSON.stringify({
      storyboardId: params.storyboardId,
      url: params.url,
      uploadType: params.uploadType,
      prompt: '1',
    }),
  })
}

/** 资产图片变更来源，与后端 AssetImageModifySource 保持一致。 */
export enum LensAssetImageModifySource {
  TaskAssociate = 'task_associate',
}

export interface LensAssetTaskAdoptionTarget {
  /** 节点业务资产分类：角色1、场景2、道具3。 */
  category: number
  entityId: string
  dramaId: string
  label: string
}

/** 关联任务原图到当前业务资产；子资产使用自身ID，严禁走分镜采纳接口。 */
export async function associateLensAssetTaskResult(target: LensAssetTaskAdoptionTarget, imageUrl: string): Promise<void> {
  if (!/^[1-9]\d*$/.test(target.entityId) || !/^[1-9]\d*$/.test(target.dramaId) || ![1, 2, 3].includes(target.category)) {
    throw new Error('资产身份或剧本信息缺失，无法采纳结果')
  }
  const url = new URL(imageUrl)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只能采纳已上传的图片原图地址')
  const isRole = target.category === 1
  await lensFetch<unknown>(isRole ? '/api/lensRole?as=lens' : '/api/lensImage?as=lens', {
    method: 'PUT',
    body: JSON.stringify(isRole
      ? { id: target.entityId, dramaId: target.dramaId, threeImg: imageUrl, modifySource: LensAssetImageModifySource.TaskAssociate }
      : { id: target.entityId, url: imageUrl, joinId: target.dramaId, modifySource: LensAssetImageModifySource.TaskAssociate }),
  })
}

/** 保存资产提示词到 Lens 业务表；资产分类和 ID 必须来自当前节点，不写入 flow。 */
export async function saveLensAssetPrompt(params: { category: number; entityId: string; dramaId: string; prompt: string }): Promise<void> {
  if (!params.entityId || !params.dramaId || ![1, 2, 3].includes(params.category)) {
    throw new Error('资产身份或剧本信息缺失，无法保存提示词')
  }
  const endpoint = params.category === 1 ? '/api/lensRole' : '/api/lensImage'
  await lensFetch<unknown>(endpoint, {
    method: 'PUT',
    body: JSON.stringify({ id: params.entityId, dramaId: params.dramaId, prompt: params.prompt }),
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

/**
 * 编辑资产引用图片（更新 name/tag/prompt/hasHuman）
 *
 * @param id 图片 ID（lens_asset_image.id）
 * @param name 资产名称
 * @param tag 标签
 * @param prompt 提示词
 * @param hasHuman 是否包含真人（0=无人，1=有真人）
 */
export async function editReference(
  id: number,
  name?: string | null,
  tag?: string | null,
  prompt?: string | null,
  hasHuman?: number | null
): Promise<unknown> {
  return lensFetch<unknown>('/api/lensImage', {
    method: 'PUT',
    body: JSON.stringify({ id, name, tag, prompt, hasHuman }),
  })
}

// ============ 画布生图链路（lens 模式下 image / imageEdit 节点的唯一出口） ============

/**
 * 提交画布生图任务。
 *
 * <p>与角色/场景资产生图（{@link listImageTasks} 那套）的关键区别：<b>画布自由节点没有
 * lens 资产身份</b>（无 lens_role / lens_asset_image 行），产出不落资产、不回填。
 *
 * <p><b>但仍需传归属信息</b>：{@code canvasFlowId} 与 {@code canvasNodeAssetId}，
 * 后端会把它们写进 task_queue 的 scene_id / asset_id（asset_type 固定为 10），
 * 使「任务结果展开」能按节点查到历史任务。这两个值由
 * {@code ensureCanvasNodeAssetId} 在 flow 数据里分配并持久化，刷新后保持稳定。
 *
 * <p>注意：不要传 assetType=0/1/2 —— 那会把画布产出回写到角色图或场景资产上，污染用户数据。
 *
 * <p>模型与分辨率由后端从剧配置推导，前端不下发 modelKey。
 *
 * @param params 提示词、剧ID、参考图与画布节点归属
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
  if (typeof params.resolution === 'string' && params.resolution.trim()) {
    payload.resolution = params.resolution.trim()
  }
  if (typeof params.quality === 'string' && params.quality.trim()) {
    payload.quality = params.quality.trim()
  }
  if (params.nodeId) payload.nodeId = params.nodeId
  if (params.nodeKind) payload.nodeKind = params.nodeKind
  // 任务归属：两者必须成对下发，只传其一会导致结果无法匹配到节点
  if (typeof params.canvasFlowId === 'number' && Number.isFinite(params.canvasFlowId)) {
    payload.canvasFlowId = Math.trunc(params.canvasFlowId)
  }
  if (typeof params.canvasNodeAssetId === 'number' && Number.isFinite(params.canvasNodeAssetId)) {
    payload.canvasNodeAssetId = Math.trunc(params.canvasNodeAssetId)
  }
  // 业务投影节点（角色/场景/道具）的真实业务身份：与 canvasNodeAssetId 互斥
  if (typeof params.assetType === 'number' && Number.isFinite(params.assetType)) {
    payload.assetType = Math.trunc(params.assetType)
  }
  if (typeof params.assetId === 'string' && params.assetId.trim()) {
    payload.assetId = params.assetId.trim()
  }

  const data = await lensFetch<LensCanvasTaskSubmitResult>('/api/application/runTaskByCanvas?as=lens', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  if (typeof data?.taskId !== 'number' || !Number.isFinite(data.taskId)) {
    throw new Error('lens 生图任务提交失败：响应未返回合法 taskId')
  }
  return data
}

/**
 * lens task_queue 状态枚举的 name（对应后端 com.zsapps.api.enums.TaskQueueStatusEnum）。
 *
 * <p>必须与后端枚举完全一致：后端还有 {@code ERROR}（多次重试后的失败终态）与
 * {@code CANCEL}（已取消）。漏掉这两个会让 {@link getCanvasTaskStatus} 把「终态失败」
 * 当成「未知状态」抛错，进而使画布恢复轮询把已结束的任务当成未完成、每 4 秒无限重查。
 */
export type LensTaskQueueStatus = 'CREATE' | 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'ERROR' | 'CANCEL'

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
  'ERROR',
  'CANCEL',
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

// ============ 节点预设能力（lens 版 /api/ai/node-presets） ============

/** 节点预设适用类型（与画布 LlmNodePresetType 一致） */
export type LensNodePresetType = 'text' | 'image' | 'video'

/** 节点预设来源：base=系统内置，user=用户自建 */
export type LensNodePresetScope = 'base' | 'user'

/** lens 节点预设条目（/api/ai/node-presets 返回元素，字段与后端 DTO 对齐） */
export interface LensNodePresetDto {
  id: string
  title: string
  type: LensNodePresetType
  prompt: string
  description?: string
  scope: LensNodePresetScope
  enabled?: boolean
  sortOrder?: number | null
  createdAt: string
  updatedAt: string
}

/** 新增节点预设入参（对应后端 POST body） */
export interface LensNodePresetCreateInput {
  title: string
  type: LensNodePresetType
  prompt: string
  description?: string
}

/** 合法类型集合：用于对后端返回值做显式校验，不做隐式兜底 */
const LENS_NODE_PRESET_TYPES: readonly LensNodePresetType[] = ['text', 'image', 'video']

/** 合法来源集合：用于对后端返回值做显式校验，不做隐式兜底 */
const LENS_NODE_PRESET_SCOPES: readonly LensNodePresetScope[] = ['base', 'user']

/**
 * 校验并归一化单条节点预设。
 *
 * <p>禁止隐式兜底：id/title/prompt/type 缺失或非法一律显式抛错，
 * 避免把脏数据静默塞进画布「预设能力」下拉，导致用户点到空提示词。
 *
 * @param raw lens 接口返回的原始条目
 * @param source 出错时用于定位的接口名
 * @returns 字段齐备的节点预设
 */
function normalizeLensNodePreset(raw: unknown, source: string): LensNodePresetDto {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`lens 节点预设解析失败（${source}）：条目不是对象`)
  }
  const item = raw as Record<string, unknown>
  const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : null
  const title = typeof item.title === 'string' && item.title.trim() ? item.title.trim() : null
  const prompt = typeof item.prompt === 'string' ? item.prompt : null
  const type = typeof item.type === 'string' ? item.type.trim() : ''
  if (!id) throw new Error(`lens 节点预设解析失败（${source}）：条目缺少 id`)
  if (!title) throw new Error(`lens 节点预设解析失败（${source}）：条目 ${id} 缺少 title`)
  if (prompt === null) throw new Error(`lens 节点预设解析失败（${source}）：条目 ${id} 缺少 prompt`)
  if (!LENS_NODE_PRESET_TYPES.includes(type as LensNodePresetType)) {
    throw new Error(`lens 节点预设解析失败（${source}）：条目 ${id} 的 type 非法（${String(item.type)}）`)
  }
  const scope = typeof item.scope === 'string' ? item.scope.trim() : ''
  if (!LENS_NODE_PRESET_SCOPES.includes(scope as LensNodePresetScope)) {
    throw new Error(`lens 节点预设解析失败（${source}）：条目 ${id} 的 scope 非法（${String(item.scope)}）`)
  }
  const sortOrder =
    typeof item.sortOrder === 'number' && Number.isFinite(item.sortOrder)
      ? item.sortOrder
      : item.sortOrder === null
        ? null
        : undefined
  return {
    id,
    title,
    type: type as LensNodePresetType,
    prompt,
    ...(typeof item.description === 'string' ? { description: item.description } : {}),
    scope: scope as LensNodePresetScope,
    ...(typeof item.enabled === 'boolean' ? { enabled: item.enabled } : {}),
    ...(sortOrder === undefined ? {} : { sortOrder }),
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
  }
}

/**
 * 读取 lens 节点预设列表。
 *
 * <p>后端按画布契约直接返回数组（无 AjaxResult 包装），故走 {@link lensFetchBare}。
 *
 * @param params.type 预设类型过滤（可选）
 * @param params.query 关键字搜索（可选，对应后端 q 参数）
 * @returns 节点预设数组
 */
export async function listLensNodePresets(params?: { type?: LensNodePresetType; query?: string }): Promise<LensNodePresetDto[]> {
  const qs = new URLSearchParams()
  if (params?.type) qs.set('type', params.type)
  if (params?.query) qs.set('q', params.query)
  const query = qs.toString()
  const url = query ? `/api/ai/node-presets?${query}` : '/api/ai/node-presets'
  const rows = await lensFetchBare(url)
  if (!Array.isArray(rows)) {
    throw new Error(`lens 节点预设列表解析失败：响应不是数组（实际为 ${rows === null ? 'null' : typeof rows}）`)
  }
  return rows.map((row) => normalizeLensNodePreset(row, 'list'))
}

/**
 * 新增 lens 节点预设。
 *
 * <p>后端返回单个预设对象（无 AjaxResult 包装），故走 {@link lensFetchBare}。
 *
 * @param payload 标题、类型、提示词与可选描述
 * @returns 新建后的节点预设
 */
export async function createLensNodePreset(payload: LensNodePresetCreateInput): Promise<LensNodePresetDto> {
  const data = await lensFetchBare('/api/ai/node-presets', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return normalizeLensNodePreset(data, 'create')
}

/**
 * 删除 lens 节点预设。
 *
 * @param id 预设ID
 */
export async function deleteLensNodePreset(id: string): Promise<void> {
  await lensFetch<unknown>(`/api/ai/node-presets/${encodeURIComponent(id)}`, { method: 'DELETE' })
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

/** 「反推画面描述」（图像理解）结果。 */
export interface LensImageUnderstandResult {
  /** 模型输出的原始文本（通常是 JSON 文本，由调用方决定如何解析展示） */
  text: string
  /** 计费信息；后端未返回时为 null（不阻断结果的使用） */
  billing: LensPromptPolishBilling | null
}

/** 「反推画面描述」（图像理解）入参。 */
export interface LensImageUnderstandParams {
  /** 待理解的图片地址，必须是在线 http(s) 链接 */
  imageUrl: string
  /** 图像理解提示词（可选；不传由后端使用内置默认提示词） */
  prompt?: string
  /** 系统提示词（可选） */
  systemPrompt?: string
  /** 模型别名（可选；后端数据源池已配 model 时以池为准） */
  modelAlias?: string
}

/**
 * 反推画面描述（lens 后端同步图像理解接口）。
 *
 * <p>背景：画布场景图片节点的「局部修改 → 反推画面描述」原先直连 TapCanvas 的
 * `POST /public/tasks`（kind=image_to_prompt），而 lens 部署下该路由不存在
 * （请求被 302 到 `/` 后返回 HTML 200），前端必然报「接口返回 HTML 而非 JSON」。
 * 本函数改为调用 lens 自己的接口，由后端按「提示词设置 → 智能分析」配置的数据源池
 * （主 → 备1 → 备2）做多模态图像理解，成功后才计费。
 *
 * @param params 图像理解入参（imageUrl / prompt / systemPrompt / modelAlias）
 * @returns 模型输出文本与计费信息
 */
export async function understandImage(params: LensImageUnderstandParams): Promise<LensImageUnderstandResult> {
  const imageUrl = typeof params.imageUrl === 'string' ? params.imageUrl.trim() : ''
  if (!imageUrl) {
    throw new Error('缺少待理解的图片地址')
  }
  const body: Record<string, unknown> = { imageUrl }
  if (params.prompt) body.prompt = params.prompt
  if (params.systemPrompt) body.systemPrompt = params.systemPrompt
  if (params.modelAlias) body.modelAlias = params.modelAlias

  const data = await lensFetch<{ text?: unknown; billing?: unknown }>('/api/canvas/imageUnderstand', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  // 显式失败：后端必须返回非空 text，拿不到就直接报错，不做任何兜底
  const text = typeof data?.text === 'string' ? data.text.trim() : ''
  if (!text) {
    throw new Error('反推画面描述失败：接口未返回有效内容')
  }
  return { text, billing: normalizeLensPromptPolishBilling(data?.billing) }
}

/**
 * 查询「反推画面描述」的计费预览（只读，不占用免费额度、不扣积分）。
 *
 * <p>与提示词润色共用「每日免费次数」「润色积分」配置，但后端按独立业务类型
 * （IMAGE_UNDERSTAND）统计，两者互不占用对方额度。
 *
 * @returns 计费预览（free / freeRemain / freeLimit / credit）
 */
export async function fetchImageUnderstandBillingPreview(): Promise<LensPromptPolishBillingPreview> {
  const data = await lensFetch<Record<string, unknown>>('/api/canvas/imageUnderstand/billing')
  const preview = normalizeLensPromptPolishBillingPreview(data)
  if (!preview) {
    throw new Error('反推画面描述计费预览失败：后端返回字段缺失或类型不符')
  }
  return preview
}

/** lens 提示词润色的计费预览（后端 previewChargePromptPolish 返回体，只读不扣分）。 */
export interface LensPromptPolishBillingPreview {
  /** 是否还能免费润色（今日剩余免费次数 > 0） */
  free: boolean
  /** 今日剩余免费次数 */
  freeRemain: number
  /** 每日免费次数上限（后台可配，最大 10） */
  freeLimit: number
  /** 一次润色消耗的积分（免费次数用尽后生效） */
  credit: number
}

/** 计费预览请求缓存的有效期（毫秒）：期内直接复用结果，实现「刷新页面每个节点各请求一次」的收敛 */
const PROMPT_POLISH_BILLING_TTL_MS = 30_000
/** 进行中的计费预览请求：同 key 的并发调用共享同一个 Promise，避免一屏节点同时挂载时打 N 次接口 */
const promptPolishBillingInFlight = new Map<string, Promise<LensPromptPolishBillingPreview>>()
/** 已完成的计费预览结果缓存（key → 结果与过期时刻） */
const promptPolishBillingCache = new Map<string, { preview: LensPromptPolishBillingPreview; expiresAt: number }>()

/**
 * 计算计费预览的缓存 key。
 *
 * <p>预览数据按后端登录用户维度统计，不同用户不得共享缓存；登录身份取不到时
 * 退回统一 key —— 此时后端本来也会按当前 cookie 判定用户，同浏览器内仍是同一份数据。
 *
 * @returns 缓存 key（形如 {@code billing:<身份>}）
 */
function buildPromptPolishBillingCacheKey(): string {
  const identity = readCookie('Admin-Token') || readCookie('admin-token') || ''
  return `billing:${identity}`
}

/**
 * 查询提示词润色的计费预览（只读接口，不占用免费额度、不扣积分）。
 *
 * <p>画布「AI润色」按钮据此展示本次润色是否免费以及消耗多少积分；
 * 真实计费仍以后端润色接口成功后返回的 billing 为准。
 *
 * <p>同一用户在一次刷新内的所有调用共享结果：进行中的请求去重（并发只发一次），
 * 完成后缓存 {@link PROMPT_POLISH_BILLING_TTL_MS}，期间页面上的多个节点不会再各请求一次。
 * 润色成功后需要实时数字时，调用方传 {@code forceRefresh = true} 跳过缓存。
 *
 * @param forceRefresh 是否跳过缓存强制请求（默认 false）
 * @returns 计费预览（free / freeRemain / freeLimit / credit）
 */
export async function fetchPromptPolishBillingPreview(
  forceRefresh = false,
): Promise<LensPromptPolishBillingPreview> {
  const cacheKey = buildPromptPolishBillingCacheKey()
  const cached = promptPolishBillingCache.get(cacheKey)
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    return cached.preview
  }
  // 先看有没有同一 key 的在途请求：有则共享，避免节点集中挂载时并发打同一接口
  const inFlight = promptPolishBillingInFlight.get(cacheKey)
  if (inFlight) return inFlight

  const request = (async (): Promise<LensPromptPolishBillingPreview> => {
    const data = await lensFetch<Record<string, unknown>>('/api/canvas/promptPolish/billing')
    const preview = normalizeLensPromptPolishBillingPreview(data)
    if (!preview) {
      throw new Error('AI润色计费预览失败：后端返回字段缺失或类型不符')
    }
    // 失败不写缓存（异常直接抛给调用方），成功才登记 TTL，保证失败后重试能真实发请求
    promptPolishBillingCache.set(cacheKey, { preview, expiresAt: Date.now() + PROMPT_POLISH_BILLING_TTL_MS })
    return preview
  })()

  promptPolishBillingInFlight.set(cacheKey, request)
  try {
    return await request
  } finally {
    // 无论成功失败都移除在途登记，避免失败后后续调用永远复用同一个 reject 的 Promise
    promptPolishBillingInFlight.delete(cacheKey)
  }
}

/**
 * 作废计费预览缓存（润色成功后调用，保证下一次预览读到最新的免费次数与积分）。
 *
 * <p>只清结果缓存、不动在途请求：在途请求完成后会写入新的结果。
 */
export function invalidatePromptPolishBillingPreviewCache(): void {
  promptPolishBillingCache.clear()
}

/**
 * 归一化润色计费预览：字段缺失或类型不符时返回 null（不做逐字段补默认值，
 * 避免把「后端没返回」伪装成「免费 0 次 / 0 积分」误导用户）。
 *
 * @param raw 后端返回的 data 字段
 * @returns 计费预览，形状不合法时返回 null
 */
function normalizeLensPromptPolishBillingPreview(raw: unknown): LensPromptPolishBillingPreview | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const toNumber = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null
  const freeRemain = toNumber(record.freeRemain)
  const freeLimit = toNumber(record.freeLimit)
  const credit = toNumber(record.credit)
  if (typeof record.free !== 'boolean' || freeRemain === null || freeLimit === null || credit === null) return null
  return {
    free: record.free,
    freeRemain,
    freeLimit,
    credit,
  }
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

// ============ 画布临时资产上传（lens OSS 直传） ============

/**
 * lens OSS PostObject 上传凭证（`POST /api/oss/upload/img/policy` 返回体）。
 *
 * <p>字段与阿里云 PostObject 表单直传一一对应：把 key/policy/OSSAccessKeyId/
 * signature/file 以 multipart 提交到 {@link LensOssPostObjectPolicy.host}，
 * 成功后文件访问地址为 `backurl + key`。与 lens 现有画布上传
 * （LeaferCanvas / ImageCropDialog）使用同一套凭证协议。
 */
export interface LensOssPostObjectPolicy {
  /** 临时 AccessKeyId（表单字段 OSSAccessKeyId） */
  accessid: string
  /** Base64 编码的上传策略（表单字段 policy） */
  policy: string
  /** 策略签名（表单字段 signature） */
  signature: string
  /** 允许写入的目录前缀（末尾带 /） */
  dir: string
  /** OSS 上传地址（PostObject 表单提交目标） */
  host: string
  /** 文件访问域前缀（最终 URL = backurl + key） */
  backurl: string
}

/** 画布临时图片上传结果 */
export interface LensCanvasUploadedAsset {
  /** 公网可访问的文件 URL（可直接作为生图参考图） */
  url: string
  /** OSS 对象 key（用于追溯，不参与业务） */
  key: string
}

/**
 * 归一化 OSS 上传凭证：字段缺失或非法时直接报错。
 *
 * <p>不做字段补默认值 —— 拿残缺凭证去传只会在 OSS 侧得到 403，
 * 错误现场不可诊断（违反「显式失败」原则）。
 *
 * @param raw lens 接口返回的 data 字段
 * @returns 校验通过的 OSS PostObject 凭证
 */
function normalizeLensOssPostObjectPolicy(raw: unknown): LensOssPostObjectPolicy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('获取 OSS 上传凭证失败：lens 返回结构不合法')
  }
  const record = raw as Record<string, unknown>
  /** 仅接受非空字符串，其余类型一律视为缺失 */
  const pickString = (key: string): string =>
    typeof record[key] === 'string' ? (record[key] as string).trim() : ''
  const policy: LensOssPostObjectPolicy = {
    accessid: pickString('accessid'),
    policy: pickString('policy'),
    signature: pickString('signature'),
    dir: pickString('dir'),
    host: pickString('host'),
    backurl: pickString('backurl'),
  }
  const missing = (Object.keys(policy) as Array<keyof LensOssPostObjectPolicy>).filter((key) => !policy[key])
  if (missing.length > 0) {
    throw new Error(`获取 OSS 上传凭证失败：lens 返回缺少字段 ${missing.join('/')}`)
  }
  if (!/^https?:\/\//i.test(policy.host)) {
    throw new Error(`获取 OSS 上传凭证失败：上传地址不合法 ${policy.host}`)
  }
  return policy
}

/**
 * 读取画布上传用的 OSS PostObject 凭证。
 *
 * <p>入参与 lens 现有画布上传完全一致（不传 dramaId），后端落到
 * `general/{userId}/image/{yyyy-MM-dd}/` 通用目录，不写剧集资产目录 ——
 * 画布生成的引导图/火柴人/拼图属临时参考图，不是业务资产。
 *
 * @returns OSS PostObject 上传凭证
 */
export async function getLensCanvasOssPostObjectPolicy(): Promise<LensOssPostObjectPolicy> {
  const raw = await lensFetch<Record<string, unknown>>('/api/oss/upload/img/policy', { method: 'POST' })
  return normalizeLensOssPostObjectPolicy(raw)
}

/**
 * 由文件名 / MIME 推断图片扩展名（OSS 按 key 后缀推断 Content-Type，必须显式带后缀）。
 *
 * @param file 上传文件
 * @param name 调用方指定的文件名（优先于 file.name）
 * @returns 小写扩展名（不含点），推断不出来时按画布导出的 PNG 处理
 */
function resolveLensCanvasUploadExtension(file: File, name?: string): string {
  const rawName = `${(name || '').trim() || (file.name || '').trim()}`.toLowerCase()
  const dotIndex = rawName.lastIndexOf('.')
  const fromName = dotIndex > 0 ? rawName.slice(dotIndex + 1) : ''
  if (fromName && /^[a-z0-9]{1,8}$/.test(fromName)) return fromName
  const fromMime = (file.type || '').toLowerCase().split('/')[1] || ''
  if (fromMime === 'jpeg') return 'jpg'
  if (fromMime && /^[a-z0-9]{1,8}$/.test(fromMime)) return fromMime
  return 'png'
}

/**
 * 构造 OSS 对象 key：目录 + canvas/ + 时间戳_随机串_清洗后的文件名。
 *
 * <p>时间戳与随机串用于避免同名文件互相覆盖；文件名只做安全清洗，
 * 保留可读性便于在 OSS 控制台追溯是哪张画布图。
 *
 * @param dir   凭证允许的目录前缀
 * @param file  上传文件
 * @param name  调用方指定的文件名
 * @returns 完整 OSS 对象 key
 */
function buildLensCanvasUploadKey(dir: string, file: File, name?: string): string {
  const normalizedDir = dir.endsWith('/') ? dir : `${dir}/`
  const extension = resolveLensCanvasUploadExtension(file, name)
  const rawName = (name || '').trim() || (file.name || '').trim() || 'canvas-asset'
  const dotIndex = rawName.lastIndexOf('.')
  const rawBase = dotIndex > 0 ? rawName.slice(0, dotIndex) : rawName
  const safeBase =
    rawBase.replace(/[\\/:*?"<>|#\s]+/g, '_').slice(0, 60) || 'canvas-asset'
  const randomToken = Math.random().toString(36).slice(2, 8)
  return `${normalizedDir}canvas/${Date.now()}_${randomToken}_${safeBase}.${extension}`
}

/**
 * 把画布生成的图片上传到 lens 的 OSS（浏览器直传，PostObject 表单）。
 *
 * <p>用于姿势/深度/尺寸调整等场景生成的临时参考图（圈选引导图、火柴人、
 * 导出图、拼图等）。这类文件由浏览器 canvas 实时生成，没有本地文件，
 * 必须先拿到公网 URL 才能作为 lens 生图任务的参考图。
 *
 * @param file 画布生成的图片文件
 * @param name 文件名（用于生成 OSS key，仅影响可读性）
 * @returns 公网 URL 与 OSS key
 */
export async function uploadLensCanvasAssetFile(file: File, name?: string): Promise<LensCanvasUploadedAsset> {
  const policy = await getLensCanvasOssPostObjectPolicy()
  const key = buildLensCanvasUploadKey(policy.dir, file, name)

  const form = new FormData()
  form.append('key', key)
  form.append('policy', policy.policy)
  form.append('OSSAccessKeyId', policy.accessid)
  form.append('success_action_status', '200')
  form.append('signature', policy.signature)
  form.append('file', file)

  const startedAt = Date.now()
  let response: Response
  try {
    response = await fetch(policy.host, { method: 'POST', body: form })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    lensLog('error', '[lens] ✗ 画布图片上传 OSS 失败（请求未到达）', {
      host: policy.host,
      key,
      costMs: Date.now() - startedAt,
      reason,
    })
    throw new Error(`画布图片上传 OSS 失败：${reason}`)
  }
  if (response.status !== 200) {
    lensLog('error', '[lens] ✗ 画布图片上传 OSS 失败（HTTP 状态非 200）', {
      host: policy.host,
      key,
      httpStatus: response.status,
      costMs: Date.now() - startedAt,
    })
    throw new Error(`画布图片上传 OSS 失败：HTTP ${response.status}`)
  }
  lensLog('log', `[lens] ✓ 画布图片已上传 OSS ${Date.now() - startedAt}ms`, { key })
  // 文件名可能含中文/空格：OSS key 保持原样上传，访问 URL 必须做 URI 编码，
  // 否则下游（浏览器 <img>、lens 后端下载参考图）拿到未编码 URL 会请求失败。
  const rawUrl = `${policy.backurl.replace(/\/+$/, '')}/${key}`
  return {
    url: encodeURI(rawUrl),
    key,
  }
}
