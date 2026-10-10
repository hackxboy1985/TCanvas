/**
 * 画布「任务结果」展开抽屉。
 *
 * <p><b>定位</b>：只读展示某个节点（自由节点 / 角色 / 场景 / 道具 / 分镜）的历史生成任务。
 * 信息结构**对齐 lens 分镜板的「分镜任务」右侧列表**
 * （`RuoYi-Vue3/src/views/lens/creation/storyboard-task/index.vue`），
 * 保证用户在两处看到同样的信息：模型、状态、提交人、Ultra 标识、分镜号、时长、
 * 时间、任务ID、渠道/画幅/参考图数、参考图缩略图、提示词、结果图，
 * 底部提供「采纳结果（仅分镜节点）」「复制提示词」「查看参数（仅管理员）」。
 *
 * <p><b>「采纳结果」</b>：把该任务的某一条结果回写到本节点对应的分镜
 * （{@code POST /api/image/addForceSet}，与 lens 分镜板 `submitToStoryboard` 同一出口）。
 * 目标分镜恒为该节点自身的 storyboardId，不做「选目标分镜」弹窗；
 * 多结果时在二次确认弹窗内显式选择要采纳的那一条（见 {@link AdoptDraft}）。
 *
 * <p><b>数据来源按节点类型区分</b>（后端接口与表都不同，必须分开）：
 * <ul>
 *   <li>自由节点：{@code /api/task/list} + assetType=10 + sceneId=flowId + assetId=节点数字ID</li>
 *   <li>角色/场景/道具：{@code /api/task/list} + assetType=0/1/2 + assetId=实体ID</li>
 *   <li>分镜：{@code /api/storyboardTask/list} + storyboardId</li>
 * </ul>
 *
 * <p><b>三态展示</b>：成功图 / 生成中（呼吸点，无百分比进度 —— 后端不返回进度）/ 失败原因。
 * <b>轮询</b>：仅存在未完成任务时 5s 轮询，全部终态自动停止；抽屉关闭即停。
 * <b>懒加载</b>：展开才查。
 */
import React from 'react'
import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Drawer,
  Group,
  Loader,
  Modal,
  Pagination,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core'
import { IconAlertTriangle, IconCheck, IconCopy, IconEye, IconRefresh } from '@tabler/icons-react'
import {
  CANVAS_NODE_ASSET_TYPE,
  adoptShotResult,
  listCanvasFreeNodeTasks,
  listShotVideoTasks,
  type LensShotFileType,
  type LensTaskRecord,
} from '../../api/lens'
import { toast } from '../../ui/toast'

/** 轮询间隔（毫秒），对齐 §5.2 的 5s */
const POLL_INTERVAL_MS = 5000
/** 每页条数 */
const PAGE_SIZE = 20

/** 任务终态（到终态后停止轮询） */
const TERMINAL_STATUSES = new Set(['SUCCESS', 'FAILED', 'ERROR', 'CANCEL', 'SYNC_FAILED'])

/** 状态中文名（对齐 lens 分镜板 statusText） */
const STATUS_TEXT: Record<string, string> = {
  CREATE: '创建',
  CREATED: '创建',
  QUEUED: '排队',
  RUNNING: '生成中',
  SYNCING: '同步中',
  SYNC_FAILED: '同步失败',
  SUCCESS: '成功',
  FAILED: '失败',
  ERROR: '失败',
  CANCEL: '已取消',
}

/**
 * 状态样式类名后缀（对齐 lens 分镜板 statusClass）。
 *
 * @param status 大写状态
 * @returns success / failed / cancel / running
 */
function statusClass(status: string): string {
  if (status === 'SUCCESS') return 'success'
  if (status === 'FAILED' || status === 'ERROR' || status === 'SYNC_FAILED') return 'failed'
  if (status === 'CANCEL') return 'cancel'
  return 'running'
}

/**
 * 任务结果抽屉的目标节点描述。
 *
 * <p>由调用方按节点类型组装，决定走哪个接口、传什么参数。
 */
export interface TaskResultTarget {
  /** 节点ID（仅用于 React key 与调试） */
  nodeId: string
  /** 节点显示名（抽屉标题） */
  title: string
  /** 节点类型 */
  kind: 'free' | 'role' | 'scene' | 'prop' | 'storyboard'
  /** 剧ID（后端权限校验用，必传） */
  dramaId: string
  /** 画布 flowId（自由节点必传） */
  canvasFlowId?: number
  /** 节点数字ID（自由节点必传） */
  canvasNodeAssetId?: number
  /** 业务实体ID（角色/场景/道具的 lens_role.id / lens_asset_image.id） */
  entityId?: string
  /** 分镜ID（分镜节点必传） */
  storyboardId?: string
}

/** 结果媒体类型：图 / 视频 */
export type TaskResultMediaType = 'image' | 'video'

/** 单条结果媒体（图或视频） */
export interface TaskResultMedia {
  /** 媒体类型 */
  type: TaskResultMediaType
  /** 原始 URL（采纳时原样提交给后端） */
  url: string
  /** 视频首帧缩略图（可选） */
  thumbnail?: string
}

/** 采纳成功后的回调载荷（供宿主同步画布节点，抽屉本身不依赖画布 store） */
export interface TaskResultAdoptedPayload {
  /** 画布节点ID */
  nodeId: string
  /** 被采纳到的分镜ID */
  storyboardId: string
  /** 被采纳的结果 URL */
  resultUrl: string
  /** 被采纳的结果类型 */
  resultType: TaskResultMediaType
}

export interface TaskResultDrawerProps {
  /** 是否打开 */
  opened: boolean
  /** 目标节点；为空表示无目标 */
  target: TaskResultTarget | null
  /** 关闭回调 */
  onClose: () => void
  /** 是否为管理员（决定「查看参数」按钮是否显示，与 lens 分镜板 canViewParams 同口径） */
  canViewParams?: boolean
  /**
   * 采纳落库成功后的回调（宿主用于把结果回写到画布节点数据）。
   *
   * <p>落库由本抽屉直接调 {@link adoptShotResult} 完成；宿主只需做节点投影同步，
   * 避免同一个采纳动作出现两条落库链路。
   */
  onAdoptResult?: (payload: TaskResultAdoptedPayload) => void
}

/** 节点类型 → 展示文案 */
const KIND_LABEL: Record<TaskResultTarget['kind'], string> = {
  free: '自由节点',
  role: '角色',
  scene: '场景',
  prop: '道具',
  storyboard: '分镜',
}

/** 资产类型映射：角色=0 场景=1 道具=2（与后端 AssetType 一致） */
const ENTITY_ASSET_TYPE: Partial<Record<TaskResultTarget['kind'], number>> = {
  role: 0,
  scene: 1,
  prop: 2,
}

/** 任务卡片视图模型（从接口原始记录归一化而来） */
interface TaskCardModel {
  /** 唯一键 */
  key: string
  /** 任务ID */
  id: string
  /** 大写状态 */
  status: string
  /** 状态中文 */
  statusText: string
  /** 状态样式后缀 */
  statusClass: string
  /** 是否处于未完成态 */
  pending: boolean
  /** 是否失败 */
  failed: boolean
  /** 模型名 */
  modelName: string
  /** 渠道 */
  channel: string
  /** 提交人 */
  submitter: string
  /** 分镜号 */
  storyboardOrder: number | null
  /** 时长（秒） */
  duration: string
  /** 画幅比例 */
  ratio: string
  /** 创建时间 */
  createTime: string
  /** 提示词 */
  prompt: string
  /** 失败原因 */
  resMsg: string
  /** Ultra 模式标识（序列任务ID 非空） */
  seqJobId: string
  /** 参考图 URL 列表 */
  refImages: string[]
  /** 参考图数量 */
  refCount: number
  /** 结果媒体列表 */
  results: TaskResultMedia[]
  /** 完整请求参数（查看参数用） */
  taskParams: string
}

/** 「采纳结果」二次确认弹窗的草稿状态（null 表示弹窗关闭） */
interface AdoptDraft {
  /** 目标分镜ID（恒为该节点自身分镜） */
  storyboardId: string
  /** 分镜展示名，如「分镜3」 */
  shotLabel: string
  /** 该任务的全部结果（供多结果时显式选择） */
  results: TaskResultMedia[]
  /** 当前选中的结果下标 */
  resultIndex: number
}

/**
 * 安全解析 JSON 字符串 / 对象。
 *
 * @param raw 原始值（可能是字符串、对象或空）
 * @returns 解析结果；失败时返回 null（不静默造数据）
 */
function safeParse(raw: unknown): unknown {
  if (raw === null || raw === undefined || raw === '') return null
  if (typeof raw === 'object') return raw
  if (typeof raw !== 'string') return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * 解析结果字段（对齐 lens 分镜板 parseResults）。
 *
 * <p>兼容两种形态：`results` 为 JSON 数组（含 type/url/thumbnail），
 * 或仅有 `fileUrl` 逗号分隔的图片串。
 *
 * @param record 任务记录
 * @returns 结果媒体列表
 */
function parseResults(record: LensTaskRecord): TaskResultMedia[] {
  const out: TaskResultMedia[] = []
  const parsed = safeParse(record.results)
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (typeof item === 'string') {
        if (item.trim()) out.push({ type: 'image', url: item.trim() })
        continue
      }
      if (!item || typeof item !== 'object') continue
      const obj = item as { type?: unknown; url?: unknown; thumbnail?: unknown }
      const url = typeof obj.url === 'string' ? obj.url.trim() : ''
      if (!url) continue
      out.push({
        type: obj.type === 'video' ? 'video' : 'image',
        url,
        thumbnail: typeof obj.thumbnail === 'string' ? obj.thumbnail : undefined,
      })
    }
  }
  // 兜底：results 为空时用 fileUrl（生图任务把多图以逗号分隔存在 fileUrl）
  if (out.length === 0) {
    const fileUrl = String(record.fileUrl || '').trim()
    for (const u of fileUrl.split(',').map((s) => s.trim()).filter(Boolean)) {
      out.push({ type: 'image', url: u })
    }
  }
  return out
}

/**
 * 从 taskParams / reqPar 提取画幅/时长/参考图。
 *
 * <p><b>两条链路的参数形态不同，都要认</b>：
 * <ul>
 *   <li>分镜节点（{@code /api/storyboardTask/list} → {@code taskParams}）：
 *       扁平对象 {@code {ratio, duration, refImages}}（画布 LensShotNode 提交的是 {@code aspectRatio}）</li>
 *   <li>资产/自由节点（{@code /api/task/list} → {@code reqPar}）：
 *       {@code task_queue.task_params}，即 {@code components} 的 JSON <b>数组</b>，
 *       形如 {@code [{"prompt","ratio","aspectRatio","resolution","images":["url"]}]}
 *       （见后端 {@code RunninghubLogin.buildTaskQueue}）</li>
 * </ul>
 * 只认扁平对象会让资产节点的「画幅」「参考图」永久为空。
 *
 * @param raw taskParams / reqPar 原始值
 * @returns 画幅、时长、参考图列表与数量
 */
function parseMeta(raw: unknown): { ratio: string; duration: string; refImages: string[]; refCount: number } {
  const meta = { ratio: '', duration: '', refImages: [] as string[], refCount: 0 }
  const p = safeParse(raw)
  if (!p) return meta

  // 资产链路：components 是数组，取第一个组件的字段（单组件提交，多组件无业务场景）
  let obj: Record<string, unknown>
  if (Array.isArray(p)) {
    const first = p[0]
    if (!first || typeof first !== 'object') return meta
    obj = first as Record<string, unknown>
  } else if (typeof p === 'object') {
    obj = p as Record<string, unknown>
  } else {
    return meta
  }

  if (typeof obj.ratio === 'string') meta.ratio = obj.ratio
  // 画布 LensShotNode 提交的是 aspectRatio（RuoYi 分镜板提交 ratio），两者都要兼容，
  // 否则画布提交的任务画幅 chip 永远为空。
  else if (typeof obj.aspectRatio === 'string') meta.ratio = obj.aspectRatio
  // 时长：资产链路的 components 可能把它放在 metadata.duration（见后端 resolveBillingDuration）
  const metaObj = obj.metadata && typeof obj.metadata === 'object' ? (obj.metadata as Record<string, unknown>) : null
  const durationRaw = obj.duration ?? metaObj?.duration
  if (typeof durationRaw === 'string') meta.duration = durationRaw
  else if (typeof durationRaw === 'number') meta.duration = String(durationRaw)

  // 参考图两种来源：分镜链路的 refImages（JSON 字符串/数组），资产链路的 components[0].images
  const refs = safeParse(obj.refImages)
  const refSource = Array.isArray(refs) ? refs : Array.isArray(obj.images) ? obj.images : null
  if (refSource) {
    meta.refImages = refSource
      .map((r) =>
        typeof r === 'string'
          ? r
          : typeof (r as { url?: unknown })?.url === 'string'
            ? String((r as { url: string }).url)
            : '',
      )
      .filter(Boolean)
    meta.refCount = meta.refImages.length
  } else if (typeof obj.refCount === 'number') {
    meta.refCount = obj.refCount
  }
  return meta
}

/**
 * 把接口原始记录归一化成卡片视图模型。
 *
 * @param record 接口返回的任务记录
 * @param index 序号（用于兜底 key）
 * @returns 卡片视图模型
 */
function toCardModel(record: LensTaskRecord, index: number): TaskCardModel {
  const status = String(record.taskStatus || record.status || '').trim().toUpperCase()
  // 两类节点的「完整请求参数」字段名不同，必须都认：
  //   分镜节点（/api/storyboardTask/list）→ taskParams
  //   角色/场景/道具/自由节点（/api/task/list）→ reqPar
  // 参考图与画幅都藏在它的 JSON 里，取错字段会导致「参考图」「画幅」永久为空。
  const rawParams = record.taskParams ?? record.reqPar
  const meta = parseMeta(rawParams)
  const refImagesRaw = Array.isArray(record.referenceImages)
    ? record.referenceImages
    : safeParse(record.referenceImages)
  const refImages = meta.refImages.length
    ? meta.refImages
    : Array.isArray(refImagesRaw)
      ? refImagesRaw.map((r) => String(r || '').trim()).filter(Boolean)
      : []
  return {
    key: String(record.id || `task-${index}`),
    id: String(record.id || ''),
    status,
    statusText: STATUS_TEXT[status] || status || '未知',
    statusClass: statusClass(status),
    pending: !TERMINAL_STATUSES.has(status),
    failed: status === 'FAILED' || status === 'ERROR' || status === 'SYNC_FAILED',
    modelName: String(record.model || record.moduleName || ''),
    channel: String(record.channel || ''),
    // 提交人字段名也不同：分镜=userName，资产/自由节点=createUserName
    submitter: String(record.submitter || record.userName || record.createUserName || ''),
    storyboardOrder: typeof record.storyboardOrder === 'number' ? record.storyboardOrder : null,
    duration: meta.duration || String(record.duration || ''),
    ratio: meta.ratio,
    createTime: String(record.createTime || ''),
    prompt: String(record.prompt || ''),
    resMsg: String(record.resMsg || record.errorMsg || ''),
    seqJobId: String(record.seqJobId || ''),
    refImages,
    refCount: refImages.length || meta.refCount,
    results: parseResults(record),
    taskParams:
      typeof rawParams === 'string' ? rawParams : rawParams ? JSON.stringify(rawParams, null, 2) : '',
  }
}

/**
 * 格式化时间（后端返回 `yyyy-MM-dd HH:mm:ss`，卡片上只保留到分钟）。
 *
 * @param value 原始时间字符串
 * @returns 展示用时间；不匹配时原样返回
 */
function formatDate(value: string): string {
  if (!value) return ''
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/)
  if (!m) return value
  return `${m[2]}-${m[3]} ${m[4]}:${m[5]}`
}

/**
 * OSS 缩略图（画布侧统一口径，避免拉原图）。
 *
 * @param url 原图 URL
 * @param width 目标宽度
 * @returns 缩略图 URL
 */
function ossThumb(url: string, width = 320): string {
  if (!url) return ''
  if (url.startsWith('data:') || url.startsWith('blob:')) return url
  if (url.includes('x-oss-process')) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}x-oss-process=image/resize,w_${width}`
}

/**
 * 视频首帧缩略图（走 OSS 视频截帧，与 lens 分镜板一致）。
 *
 * @param url 视频 URL
 * @returns 缩略图 URL；已带处理参数时返回空串
 */
function videoPoster(url: string): string {
  if (!url || url.includes('x-oss-process')) return ''
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}x-oss-process=video/snapshot,t_1,f_jpg,w_700`
}

export function TaskResultDrawer({
  opened,
  target,
  onClose,
  canViewParams = false,
  onAdoptResult,
}: TaskResultDrawerProps) {
  const [records, setRecords] = React.useState<LensTaskRecord[]>([])
  const [total, setTotal] = React.useState(0)
  const [page, setPage] = React.useState(1)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  /** 查看参数弹窗内容（空串表示关闭） */
  const [paramsText, setParamsText] = React.useState('')
  /** 采纳二次确认弹窗草稿（null 表示关闭） */
  const [adoptDraft, setAdoptDraft] = React.useState<AdoptDraft | null>(null)
  /** 采纳请求进行中（防止重复提交） */
  const [adopting, setAdopting] = React.useState(false)
  const pollTimerRef = React.useRef<number | null>(null)

  /** 停止轮询（关闭抽屉 / 全部终态 / 卸载时调用） */
  const stopPolling = React.useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  /**
   * 按目标节点类型查询任务。
   *
   * <p>自由节点必须带 canvasFlowId + canvasNodeAssetId，否则会串到同画布其它节点。
   */
  const fetchTasks = React.useCallback(
    async (targetPage: number): Promise<void> => {
      if (!target) return
      setLoading(true)
      setError(null)
      try {
        if (target.kind === 'storyboard') {
          if (!target.storyboardId) throw new Error('分镜节点缺少分镜ID，无法查询任务')
          const res = await listShotVideoTasks({
            dramaId: target.dramaId,
            storyboardId: target.storyboardId,
            pageNum: targetPage,
            pageSize: PAGE_SIZE,
          })
          setRecords(Array.isArray(res.rows) ? res.rows : [])
          setTotal(res.total ?? 0)
          return
        }
        if (target.kind === 'free') {
          if (target.canvasFlowId === undefined || target.canvasNodeAssetId === undefined) {
            throw new Error('自由节点缺少画布归属（canvasFlowId / canvasNodeAssetId），无法查询任务')
          }
          const res = await listCanvasFreeNodeTasks({
            dramaId: target.dramaId,
            sceneId: target.canvasFlowId,
            assetType: CANVAS_NODE_ASSET_TYPE,
            assetId: target.canvasNodeAssetId,
            pageNum: targetPage,
            pageSize: PAGE_SIZE,
          })
          setRecords(Array.isArray(res.rows) ? res.rows : [])
          setTotal(res.total ?? 0)
          return
        }
        // 角色/场景/道具：按业务实体查询（与归一角色界面同口径）
        const assetType = ENTITY_ASSET_TYPE[target.kind]
        if (assetType === undefined || !target.entityId) {
          throw new Error('资产节点缺少实体ID，无法查询任务')
        }
        const entityAssetId = Number(target.entityId)
        if (!Number.isFinite(entityAssetId) || entityAssetId <= 0) {
          throw new Error(`资产实体ID非法：${target.entityId}`)
        }
        const res = await listCanvasFreeNodeTasks({
          dramaId: target.dramaId,
          assetType,
          assetId: Math.trunc(entityAssetId),
          pageNum: targetPage,
          pageSize: PAGE_SIZE,
        })
        setRecords(Array.isArray(res.rows) ? res.rows : [])
        setTotal(res.total ?? 0)
      } catch (err) {
        setRecords([])
        setTotal(0)
        setError(err instanceof Error ? err.message : '任务查询失败')
      } finally {
        setLoading(false)
      }
    },
    [target],
  )

  // 关闭抽屉 / 切换目标时丢弃未确认的采纳草稿（避免残留上一次的上下文）
  React.useEffect(() => {
    if (!opened) setAdoptDraft(null)
  }, [opened])

  /**
   * 打开「采纳结果」二次确认弹窗。
   *
   * @param card 来源任务卡片
   * @param storyboardId 目标分镜ID（本节点自身分镜）
   * @param resultIndex 默认选中的结果下标
   */
  const openAdoptConfirm = React.useCallback(
    (card: TaskCardModel, storyboardId: string, resultIndex: number) => {
      setAdoptDraft({
        storyboardId,
        shotLabel: card.storyboardOrder !== null ? `分镜${card.storyboardOrder}` : '当前分镜',
        results: card.results,
        resultIndex,
      })
    },
    [],
  )

  /**
   * 提交采纳：调后端落库，成功后通知宿主同步画布节点。
   *
   * <p>失败不做任何兜底（不本地假写节点、不重试到其它分镜）：toast 出后端原始原因并保留弹窗。
   */
  const confirmAdopt = React.useCallback(async (): Promise<void> => {
    if (!adoptDraft || !target) return
    const media = adoptDraft.results[adoptDraft.resultIndex]
    if (!media || !media.url) {
      toast('该结果没有可采纳的地址，无法采纳', 'error')
      return
    }
    /** 媒体 → uploadType：0=图 1=视频（与 lens_storyboard.select_file_type 一致） */
    const uploadType: LensShotFileType = media.type === 'video' ? 1 : 0
    setAdopting(true)
    try {
      await adoptShotResult({
        storyboardId: adoptDraft.storyboardId,
        url: media.url,
        uploadType,
      })
      setAdoptDraft(null)
      toast(`已采纳${media.type === 'video' ? '视频' : '图片'}到${adoptDraft.shotLabel}`, 'success')
      onAdoptResult?.({
        nodeId: target.nodeId,
        storyboardId: adoptDraft.storyboardId,
        resultUrl: media.url,
        resultType: media.type,
      })
    } catch (err) {
      // 显式暴露失败原因，禁止静默兜底
      toast(`采纳失败：${err instanceof Error ? err.message : '未知错误'}`, 'error')
    } finally {
      setAdopting(false)
    }
  }, [adoptDraft, target, onAdoptResult])

  // 打开时懒加载第一页；关闭时停止轮询并清空（满足「展开才查、收起即停」）
  React.useEffect(() => {
    if (!opened || !target) {
      stopPolling()
      setRecords([])
      setTotal(0)
      setPage(1)
      setError(null)
      return
    }
    setPage(1)
    void fetchTasks(1)
  }, [opened, target, fetchTasks, stopPolling])

  // 轮询：仅当本页存在未完成任务时启动，全部终态后自动停止
  React.useEffect(() => {
    if (!opened || !target) {
      stopPolling()
      return
    }
    const hasPending = records.some(
      (r) => !TERMINAL_STATUSES.has(String(r.taskStatus || r.status || '').toUpperCase()),
    )
    if (!hasPending) {
      stopPolling()
      return
    }
    if (pollTimerRef.current !== null) return
    pollTimerRef.current = window.setInterval(() => {
      void fetchTasks(page)
    }, POLL_INTERVAL_MS)
    return stopPolling
  }, [opened, target, records, page, fetchTasks, stopPolling])

  // 组件卸载时兜底清理定时器
  React.useEffect(() => stopPolling, [stopPolling])

  /**
   * 复制提示词（与 lens 分镜板 copyText 同行为）。
   *
   * @param prompt 提示词
   */
  const copyPrompt = React.useCallback((prompt: string) => {
    if (!prompt) {
      toast('该任务没有提示词')
      return
    }
    void navigator.clipboard
      .writeText(prompt)
      .then(() => toast('提示词已复制', 'success'))
      .catch(() => toast('复制失败，请手动选择文本复制', 'error'))
  }, [])

  const cards = React.useMemo(() => records.map((r, i) => toCardModel(r, i)), [records])
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  /**
   * 「采纳结果」是否可用。
   *
   * <p>只有分镜节点有自身对应的分镜（target.storyboardId）；角色/场景/道具/自由节点
   * 没有可回写的分镜，因此不显示该按钮（不猜测目标、不降级）。
   */
  const adoptStoryboardId = target?.kind === 'storyboard' ? target.storyboardId : undefined
  const canAdopt = Boolean(adoptStoryboardId)
  /** 当前采纳草稿选中的结果（用于弹窗预览与按钮文案） */
  const adoptSelectedMedia = adoptDraft ? adoptDraft.results[adoptDraft.resultIndex] : undefined

  return (
    <>
      <Drawer
        opened={opened}
        onClose={onClose}
        position="right"
        size="xl"
        title={
          <Group gap="xs">
            <Text fw={600}>任务列表</Text>
            {target && <Badge variant="light">{KIND_LABEL[target.kind]}</Badge>}
            {target && (
              <Text size="sm" c="dimmed">
                {target.title}
              </Text>
            )}
          </Group>
        }
        className="lens-task-result-drawer"
      >
        <Stack gap="sm">
          {/* 顶部：条数 + 刷新 */}
          <Group justify="space-between">
            <Text size="sm" c="dimmed">
              {loading ? '查询中…' : `共 ${total} 条`}
            </Text>
            <Tooltip label="刷新">
              <ActionIcon variant="subtle" onClick={() => void fetchTasks(page)} aria-label="刷新任务列表">
                <IconRefresh size={16} />
              </ActionIcon>
            </Tooltip>
          </Group>

          {error && (
            <Group gap="xs" wrap="nowrap" align="flex-start">
              <IconAlertTriangle size={16} />
              <Text size="sm">{error}</Text>
            </Group>
          )}

          {!error && loading && cards.length === 0 && (
            <Center py="lg">
              <Loader size="sm" />
            </Center>
          )}

          {!error && !loading && cards.length === 0 && (
            <Center py="lg">
              <Text size="sm" c="dimmed">
                暂无任务记录
              </Text>
            </Center>
          )}

          {/* 任务卡片列表（信息对齐 lens 分镜板「分镜任务」右侧列表） */}
          {cards.map((card) => (
            <div key={card.key} className={`lens-task-card lens-task-card--${card.statusClass}`}>
              {/* 顶部元信息行 */}
              <div className="lens-task-card-header">
                <div className="lens-task-meta-left">
                  {card.modelName && <span className="lens-task-module-chip">{card.modelName}</span>}
                  {card.storyboardOrder !== null && (
                    <span className="lens-task-shot-tag">分镜{card.storyboardOrder}</span>
                  )}
                  <span className={`lens-task-status-pill lens-task-status-pill--${card.statusClass}`}>
                    {card.statusText}
                  </span>
                  {card.pending && <span className="lens-task-fresh-hint">需手动刷新</span>}
                  {card.submitter && <span className="lens-task-meta-text">{card.submitter}</span>}
                  {card.seqJobId && (
                    <Tooltip label={`序列任务 ${card.seqJobId}`}>
                      <span className="lens-task-ultra-tag">Ultra</span>
                    </Tooltip>
                  )}
                </div>
                <div className="lens-task-meta-right">
                  {card.duration && <span className="lens-task-meta-text">{card.duration}s</span>}
                  {card.createTime && <span className="lens-task-meta-text">{formatDate(card.createTime)}</span>}
                  <span className="lens-task-meta-text lens-task-meta-mono">
                    {card.id ? `#${card.id}` : '排队中'}
                  </span>
                </div>
              </div>

              {/* 渠道 / 画幅 / 参考图数 */}
              {(card.channel || card.ratio || card.refCount > 0) && (
                <div className="lens-task-info-row">
                  {card.channel && <span className="lens-task-info-chip">{card.channel}</span>}
                  {card.ratio && <span className="lens-task-info-chip">{card.ratio}</span>}
                  {card.refCount > 0 && <span className="lens-task-info-chip">{card.refCount} 参考图</span>}
                </div>
              )}

              {/* 参考图缩略图 */}
              {card.refImages.length > 0 && (
                <div className="lens-task-ref-imgs">
                  {card.refImages.map((img, i) => (
                    <a
                      key={`${img}-${i}`}
                      href={img}
                      target="_blank"
                      rel="noreferrer"
                      className="lens-task-ref-link"
                    >
                      <img className="lens-task-ref-thumb" src={ossThumb(img, 200)} alt="" loading="lazy" />
                    </a>
                  ))}
                </div>
              )}

              {/* 提示词（hover 展示完整内容，超长截断） */}
              {card.prompt && (
                <Tooltip label={card.prompt} multiline maw={560} position="bottom" withArrow openDelay={300}>
                  <div className="lens-task-prompt">{card.prompt}</div>
                </Tooltip>
              )}

              {/* 中部：结果区（三态） */}
              <div className="lens-task-result-area">
                {card.failed && card.results.length === 0 && (
                  <div className="lens-task-failed-msg">
                    <IconAlertTriangle size={14} />
                    <span>{card.resMsg || '任务失败'}</span>
                  </div>
                )}
                {!card.failed && card.pending && card.results.length === 0 && (
                  <div className="lens-task-generating">
                    <span className="lens-shot-status-dot lens-shot-status-dot--generating" />
                    <span>生成中，请稍候…</span>
                  </div>
                )}
                {card.results.length > 0 && (
                  <div className="lens-task-results">
                    {card.results.map((r, i) =>
                      r.type === 'video' ? (
                        <div key={`${r.url}-${i}`} className="lens-task-result-item">
                          <video
                            className="lens-task-result-media"
                            src={r.url}
                            poster={r.thumbnail || videoPoster(r.url)}
                            preload="metadata"
                            muted
                            controls
                          />
                        </div>
                      ) : (
                        <a
                          key={`${r.url}-${i}`}
                          href={r.url}
                          target="_blank"
                          rel="noreferrer"
                          className="lens-task-result-item"
                        >
                          <img className="lens-task-result-media" src={ossThumb(r.url, 350)} alt="" loading="lazy" />
                        </a>
                      ),
                    )}
                  </div>
                )}
                {!card.failed && !card.pending && card.results.length === 0 && (
                  <div className="lens-task-no-result">暂无结果</div>
                )}
              </div>

              {/* 底部操作（对齐 lens 分镜板：采纳结果 / 复制提示词 / 查看参数，仅管理员） */}
              <div className="lens-task-card-actions">
                {/* 采纳结果：仅分镜节点可用；多结果时默认第一条，可在弹窗内切换 */}
                {canAdopt && adoptStoryboardId && (
                  <Tooltip
                    className="lens-task-adopt-tip"
                    label={card.results.length > 1 ? '选择本任务中的一条结果采纳到该分镜' : '采纳该结果到本节点对应的分镜'}
                  >
                    <Button
                      className="lens-task-adopt-btn"
                      variant="filled"
                      size="compact-xs"
                      disabled={card.results.length === 0}
                      leftSection={<IconCheck size={13} />}
                      onClick={() => openAdoptConfirm(card, adoptStoryboardId, 0)}
                    >
                      采纳结果
                    </Button>
                  </Tooltip>
                )}
                <Button
                  variant="outline"
                  size="compact-xs"
                  leftSection={<IconCopy size={13} />}
                  onClick={() => copyPrompt(card.prompt)}
                >
                  复制提示词
                </Button>
                {canViewParams && (
                  <Button
                    variant="light"
                    size="compact-xs"
                    leftSection={<IconEye size={13} />}
                    onClick={() => setParamsText(card.taskParams || '（该任务没有记录请求参数）')}
                  >
                    查看参数
                  </Button>
                )}
              </div>
            </div>
          ))}

          {pageCount > 1 && (
            <Pagination
              value={page}
              total={pageCount}
              onChange={(p) => {
                setPage(p)
                void fetchTasks(p)
              }}
              size="sm"
            />
          )}
        </Stack>
      </Drawer>

      {/* 查看参数弹窗（仅管理员，对齐 lens 分镜板 reqParDialog） */}
      <Modal opened={paramsText !== ''} onClose={() => setParamsText('')} title="任务详情" size="lg">
        <pre className="lens-task-reqpar">{paramsText}</pre>
      </Modal>

      {/* 采纳结果二次确认：目标分镜恒为本节点自身分镜，多结果时在此显式选择 */}
      <Modal
        opened={adoptDraft !== null}
        onClose={() => setAdoptDraft(null)}
        title="采纳结果"
        size="md"
        className="lens-task-adopt-modal"
      >
        {adoptDraft && (
          <Stack className="lens-task-adopt-body" gap="sm">
            <Text className="lens-task-adopt-confirm">
              确认将{adoptSelectedMedia?.type === 'video' ? '视频' : '图片'}采纳到{adoptDraft.shotLabel}吗？采纳后该分镜的选中结果会被覆盖。
            </Text>

            {adoptDraft.results.length > 1 && (
              <div className="lens-task-adopt-picker">
                <Text className="lens-task-adopt-picker-label" size="xs">
                  该任务有 {adoptDraft.results.length} 个结果，请选择要采纳的一个：
                </Text>
                <div className="lens-task-adopt-options">
                  {adoptDraft.results.map((media, i) => (
                    <button
                      key={`${media.url}-${i}`}
                      type="button"
                      className={
                        i === adoptDraft.resultIndex
                          ? 'lens-task-adopt-option lens-task-adopt-option--active'
                          : 'lens-task-adopt-option'
                      }
                      onClick={() => setAdoptDraft((draft) => (draft ? { ...draft, resultIndex: i } : draft))}
                    >
                      <img
                        className="lens-task-adopt-option-thumb"
                        src={media.type === 'video' ? media.thumbnail || videoPoster(media.url) : ossThumb(media.url, 200)}
                        alt=""
                        loading="lazy"
                      />
                      <span className="lens-task-adopt-option-text">
                        {media.type === 'video' ? `视频 ${i + 1}` : `图片 ${i + 1}`}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <Group className="lens-task-adopt-actions" justify="flex-end" gap="xs">
              <Button className="lens-task-adopt-cancel" variant="default" size="xs" onClick={() => setAdoptDraft(null)}>
                取消
              </Button>
              <Button
                className="lens-task-adopt-submit"
                variant="filled"
                size="xs"
                loading={adopting}
                leftSection={<IconCheck size={14} />}
                onClick={() => void confirmAdopt()}
              >
                确认采纳
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </>
  )
}

export default TaskResultDrawer
