import React from 'react'
import { ActionIcon, Badge, Button, Group, Loader, Pagination, Select, Text } from '@mantine/core'
import { IconArrowsMaximize, IconRefresh, IconX } from '@tabler/icons-react'
import { CANVAS_NODE_ASSET_TYPE, LensAssetTaskStatus, listAssetImageTasks, listCanvasFreeNodeTasks, canViewTaskParams, type LensAssetTaskAdoptionTarget, type LensModelOption } from '../../api/lens'
import { getLensCanvasFlowId, readCanvasNodeAssetId } from '../utils/canvasNodeAssetId'
import { readLensAssetTaskIdentity } from '../utils/lensAssetTaskIdentity'
import { useRFStore } from '../store'
import { loadLensAssetTaskApplications, resolveLensTaskApplicationName } from '../utils/lensAssetTaskApplications'
import { AssetTaskPanelCard } from './AssetTaskPanelCard'
import {
  collectDerivedTaskRows,
  filterTasksAfterNodeCreated,
  type DerivedTaskRecord,
} from '../utils/derivedTasks'

/** 面板任务记录：衍生节点任务额外带来源标签（角度修改/打光调整/自定义编辑） */
type PanelTaskRecord = DerivedTaskRecord

const PAGE_SIZE = 20
/** 有未终态任务时的轮询间隔（毫秒）：只在存在排队/生成中任务时续期，全终态即停止 */
const POLL_INTERVAL_MS = 20000
const STATUS_OPTIONS = [
  { value: LensAssetTaskStatus.All, label: '默认：隐藏失败' },
  { value: LensAssetTaskStatus.Created, label: '创建' },
  { value: LensAssetTaskStatus.Queued, label: '排队' },
  { value: LensAssetTaskStatus.Running, label: '生成中' },
  { value: LensAssetTaskStatus.Success, label: '成功' },
  { value: LensAssetTaskStatus.Failed, label: '失败' },
]
const PENDING_STATUSES = new Set(['CREATE', 'CREATED', 'QUEUED', 'RUNNING', 'SYNCING'])
/**
 * 节点自带的生图任务列表（点节点上的「任务记录」图标打开）。
 *
 * <p>只查**当前节点自己的任务**，两种身份各走各的口径：
 * <ul>
 *   <li>业务资产节点（角色/场景/道具）：assetType + assetId（实体ID），走 /api/task/list 业务口径；</li>
 *   <li>画布自由节点（含衍生出的图片编辑、角度、打光节点）：sceneId(画布flowId) + assetType=10
 *       + assetId(节点数字ID)，只查本节点自己的任务 —— 不再把衍生节点的任务汇总到来源资产节点上。</li>
 * </ul>
 *
 * @param nodeId 当前节点ID
 * @param data 节点数据（用于识别任务身份）
 * @param onClose 关闭回调
 * @param onExpand 展开到右侧抽屉
 */
export function AssetTaskPanel({ nodeId, data, onClose, onExpand }: {
  nodeId: string; data: Record<string, unknown>; onClose: () => void; onExpand?: () => void
}) {
  const identity = readLensAssetTaskIdentity(data)
  const dramaId = new URLSearchParams(window.location.search).get('dramaId')?.trim() || ''
  const flowId = getLensCanvasFlowId()
  const canvasNodeAssetId = readCanvasNodeAssetId(data)
  const assetId = identity?.assetId
  const assetType = identity?.assetType
  /**
   * 「采纳结果」的目标资产。
   *
   * <p>只有业务资产节点（角色/场景/道具，带实体ID）才有可关联的业务记录；
   * 画布自由节点与衍生节点（角度/打光/局部编辑）没有业务实体，关联接口无处落库，
   * 因此不展示采纳按钮，避免给出一个点了必然失败的入口。
   */
  const adoptTarget: LensAssetTaskAdoptionTarget | undefined =
    assetId && assetType !== undefined && dramaId
      ? {
          category: assetType + 1,
          entityId: assetId,
          dramaId,
          label: typeof data.label === 'string' && data.label ? data.label : '当前资产',
        }
      : undefined
  /**
   * 是否为画布自由节点（含角度/打光/局部编辑等衍生节点）。
   *
   * <p>这类节点没有业务资产实体，但任务归属稳定（assetType=10 + 节点数字ID），
   * 任务能正常查出来；「采纳结果」在这里的含义是把结果设为**节点自身的当前主图**，
   * 由节点 data 承载，不写业务表。因此必须给它们保留采纳入口，
   * 否则衍生节点产出的图只能看、不能选为节点的当前图。
   */
  const canAdoptToNode = !adoptTarget && canvasNodeAssetId !== null
  /**
   * 把选中的任务结果设为当前节点的主图。
   *
   * <p>命中原有结果则只切换主图下标，未命中则追加为新结果，
   * 与节点自身生图写入的 imageResults/imageUrl/imagePrimaryIndex 结构保持一致。
   *
   * @param imageUrl 选中的结果图片地址
   */
  const handleAdoptNodeImage = React.useCallback((imageUrl: string): void => {
    const store = useRFStore.getState()
    // 以 store 里的最新 data 为准：面板渲染期间节点可能刚被生图回写过
    const latestData = (store.nodes.find((node) => node.id === nodeId)?.data || data) as Record<string, unknown>
    const previous = Array.isArray(latestData.imageResults)
      ? (latestData.imageResults as Array<Record<string, unknown>>)
      : []
    const results = previous.map((item) => ({ ...item }))
    let index = results.findIndex((item) => String(item?.url || '') === imageUrl)
    if (index < 0) {
      index = results.length
      results.push({ url: imageUrl })
    }
    store.updateNodeData(nodeId, { imageResults: results, imageUrl, imagePrimaryIndex: index })
  }, [data, nodeId])
  const [canViewParams, setCanViewParams] = React.useState(false)
  React.useEffect(() => {
    let active = true
    void canViewTaskParams().then((allowed) => { if (active) setCanViewParams(allowed) })
      .catch(() => { if (active) setCanViewParams(false) })
    return () => { active = false }
  }, [])
  const [page, setPage] = React.useState(1)
  const [status, setStatus] = React.useState(LensAssetTaskStatus.All)
  const [refresh, setRefresh] = React.useState(0)
  const [records, setRecords] = React.useState<PanelTaskRecord[]>([])
  const [total, setTotal] = React.useState(0)
  const [applications, setApplications] = React.useState<LensModelOption[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    async function query(): Promise<void> {
      setLoading(true)
      setError(null)
      try {
        if (!dramaId) throw new Error('缺少剧信息，无法查询任务')
        // 应用名解析表必须两个分支都加载：
        // 自由节点（含局部修改等衍生节点）虽然查询不按应用筛选，但任务卡片要把 originAppId
        // 显示成用户选择的应用名；此前只在业务资产分支加载，自由节点恒为空数组，
        // 导致任务显示成「未匹配应用（73）」。loadLensAssetTaskApplications 空列表不抛错。
        // 该函数自带会话级缓存（并发去重 + 5 分钟 TTL），面板 5 秒轮询不会重复打接口。
        const models = await loadLensAssetTaskApplications()
        if (disposed) return
        setApplications(models)
        // 画布自由节点（含衍生节点）：按节点自身的归属三元组查询，只查本节点的任务
        const isCanvasFreeNode = canvasNodeAssetId !== null && flowId !== undefined
        if (isCanvasFreeNode) {
          const freeResult = await listCanvasFreeNodeTasks({
            dramaId,
            sceneId: flowId,
            assetType: CANVAS_NODE_ASSET_TYPE,
            assetId: canvasNodeAssetId,
            pageNum: page,
            pageSize: PAGE_SIZE,
          })
          if (disposed) return
          // 节点复用数字ID时，旧节点的历史任务会挂在同一 assetId 下，按节点入画布时间过滤
          const freeRows: PanelTaskRecord[] = filterTasksAfterNodeCreated(
            Array.isArray(freeResult.rows) ? freeResult.rows : [],
            data.nodeCreatedAt,
          )
          setRecords(freeRows)
          setTotal(freeRows.length)
          if (freeRows.some((record) => PENDING_STATUSES.has(record.taskStatus || record.status || ''))) {
            timer = setTimeout(() => { void query() }, POLL_INTERVAL_MS)
          }
          return
        }
        if (!assetId || assetType === undefined) throw new Error('缺少剧或资产信息，无法查询任务')
        const applicationIds = models.filter((model) => model.enabled === true).map((model) => String(model.value))
        if (!applicationIds.length) throw new Error('当前未配置可用生图应用，无法筛选资产任务')
        const result = await listAssetImageTasks({ dramaId, assetId, assetType, applicationIds,
          taskStatus: status, pageNum: page, pageSize: PAGE_SIZE })
        if (disposed) return
        const assetRows: PanelTaskRecord[] = Array.isArray(result.rows) ? result.rows : []
        // 本节点衍生出的图片编辑节点任务：业务资产节点要能看到自己衍生的任务，
        // 但每个衍生节点只取「节点入画布之后」的任务，避免数字ID复用带来的串号。
        const derivedRows: PanelTaskRecord[] = page === 1 && flowId !== undefined
          ? await collectDerivedTaskRows({ dramaId, flowId, nodeId, matchStatus: status })
          : []
        if (disposed) return
        const merged = [...assetRows, ...derivedRows].sort(
          (a, b) => new Date(b.createTime || 0).getTime() - new Date(a.createTime || 0).getTime(),
        )
        setRecords(merged)
        setTotal(result.total + derivedRows.length)
        if (merged.some((record) => PENDING_STATUSES.has(record.taskStatus || record.status || ''))) {
          timer = setTimeout(() => { void query() }, POLL_INTERVAL_MS)
        }
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : '任务列表加载失败')
      } finally {
        if (!disposed) setLoading(false)
      }
    }
    setRecords([])
    setTotal(0)
    void query()
    return () => { disposed = true; if (timer) clearTimeout(timer) }
  }, [assetId, assetType, canvasNodeAssetId, flowId, dramaId, page, status, refresh])

  return (
    <aside className="lens-asset-task-panel nodrag nopan nowheel" aria-label="资产任务列表"
      onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
      <Group className="lens-asset-task-panel__header" gap="xs" wrap="nowrap">
        <ActionIcon className="lens-asset-task-panel__close" variant="subtle" color="gray" aria-label="关闭任务列表" onClick={onClose}>
          <IconX className="lens-asset-task-panel__close-icon" size={16} />
        </ActionIcon>
        <Text className="lens-asset-task-panel__title" size="sm" fw={600}>任务列表</Text>
        <ActionIcon className="lens-asset-task-panel__refresh" variant="subtle" color="gray" aria-label="刷新任务列表"
          loading={loading} onClick={() => setRefresh((value) => value + 1)}>
          <IconRefresh className="lens-asset-task-panel__refresh-icon" size={16} />
        </ActionIcon>
        <Badge className="lens-asset-task-panel__count" variant="light" color="gray">{total}</Badge>
        {onExpand && (
          <ActionIcon className="lens-asset-task-panel__expand" variant="subtle" color="gray"
            aria-label="扩展任务列表" title="扩展任务列表" onClick={onExpand}>
            <IconArrowsMaximize className="lens-asset-task-panel__expand-icon" size={16} />
          </ActionIcon>
        )}
      </Group>
      <Select className="lens-asset-task-panel__status" size="xs" aria-label="资产任务状态" data={STATUS_OPTIONS}
        value={status} allowDeselect={false} onChange={(value) => {
          if (value !== null) { setPage(1); setStatus(value as LensAssetTaskStatus) }
        }} />
      <div className="lens-asset-task-panel__body nowheel" aria-live="polite">
        {error && <Text className="lens-asset-task-panel__error" c="red" size="sm">{error}</Text>}
        {error && <Button className="lens-asset-task-panel__retry" size="compact-xs" variant="subtle" onClick={() => setRefresh((value) => value + 1)}>重新加载</Button>}
        {!error && loading && records.length === 0 && <Loader className="lens-asset-task-panel__loading" size="sm" />}
        {!error && !loading && records.length === 0 && <Text className="lens-asset-task-panel__empty" size="sm">暂无任务记录</Text>}
        {records.map((record, index) => <AssetTaskPanelCard key={record.id || index} record={record} derivedLabel={record.derivedLabel} applicationName={resolveLensTaskApplicationName(record.originAppId, applications)} canViewParams={canViewParams}
          target={adoptTarget} onAdoptNodeImage={canAdoptToNode ? handleAdoptNodeImage : undefined} />)}
      </div>
      {total > PAGE_SIZE && <Pagination className="lens-asset-task-panel__pagination" size="xs" siblings={0} boundaries={1}
        total={Math.ceil(total / PAGE_SIZE)} value={page} onChange={setPage} />}
    </aside>
  )
}
