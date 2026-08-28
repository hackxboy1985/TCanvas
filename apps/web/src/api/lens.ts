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

/** 统一请求封装：带 lens token，解包 RuoYi 结构 */
async function lensFetch<T>(url: string, opts?: RequestInit): Promise<T> {
  const token = readCookie('Admin-Token')
  const r = await fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts?.headers || {}),
    },
  })
  const body = await r.json().catch(() => ({})) as { code?: number; msg?: string; data?: unknown; rows?: unknown }
  if (body.code !== 200) throw new Error(body.msg || 'lens 接口失败')
  // TableDataInfo 返回 rows；AjaxResult 返回 data
  if (Array.isArray(body.rows)) return body.rows as T
  return (body.data ?? body) as T
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
