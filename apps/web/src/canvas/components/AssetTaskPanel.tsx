import React from 'react'
import { ActionIcon, Badge, Button, Group, Loader, Pagination, Select, Text } from '@mantine/core'
import { IconRefresh, IconX } from '@tabler/icons-react'
import { LensAssetTaskStatus, listAssetImageTasks, canViewTaskParams, type LensTaskRecord, type LensModelOption } from '../../api/lens'
import { readLensAssetTaskIdentity } from '../utils/lensAssetTaskIdentity'
import { loadLensAssetTaskApplications, resolveLensTaskApplicationName } from '../utils/lensAssetTaskApplications'
import { AssetTaskPanelCard } from './AssetTaskPanelCard'

const PAGE_SIZE = 20
const POLL_INTERVAL_MS = 5000
const STATUS_OPTIONS = [
  { value: LensAssetTaskStatus.All, label: '默认：隐藏失败' },
  { value: LensAssetTaskStatus.Created, label: '创建' },
  { value: LensAssetTaskStatus.Queued, label: '排队' },
  { value: LensAssetTaskStatus.Running, label: '生成中' },
  { value: LensAssetTaskStatus.Success, label: '成功' },
  { value: LensAssetTaskStatus.Failed, label: '失败' },
]
const PENDING_STATUSES = new Set(['CREATE', 'CREATED', 'QUEUED', 'RUNNING', 'SYNCING'])

/** 独立于原右侧抽屉的资产任务列表；只在挂载时查询，卸载即停止轮询并废弃在途响应。 */
export function AssetTaskPanel({ data, onClose }: {
  data: Record<string, unknown>; onClose: () => void
}) {
  const identity = readLensAssetTaskIdentity(data)
  const dramaId = new URLSearchParams(window.location.search).get('dramaId')?.trim() || ''
  const assetId = identity?.assetId
  const assetType = identity?.assetType
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
  const [records, setRecords] = React.useState<LensTaskRecord[]>([])
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
        if (!assetId || assetType === undefined || !dramaId) throw new Error('缺少剧或资产信息，无法查询任务')
        const models = await loadLensAssetTaskApplications()
        if (disposed) return
        const applicationIds = models.filter((model) => model.enabled === true).map((model) => String(model.value))
        if (!applicationIds.length) throw new Error('当前未配置可用生图应用，无法筛选资产任务')
        setApplications(models)
        const result = await listAssetImageTasks({ dramaId, assetId, assetType, applicationIds,
          taskStatus: status, pageNum: page, pageSize: PAGE_SIZE })
        if (disposed) return
        setRecords(result.rows)
        setTotal(result.total)
        if (result.rows.some((record) => PENDING_STATUSES.has(record.taskStatus || record.status || ''))) {
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
  }, [assetId, assetType, dramaId, page, status, refresh])

  return (
    <aside className="lens-asset-task-panel nodrag nopan nowheel" aria-label="资产任务列表"
      onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
      <Group className="lens-asset-task-panel__header" gap="xs" wrap="nowrap">
        <ActionIcon className="lens-asset-task-panel__close" variant="subtle" color="gray" aria-label="关闭任务列表" onClick={onClose}>
          <IconX className="lens-asset-task-panel__close-icon" size={16} />
        </ActionIcon>
        <Text className="lens-asset-task-panel__title" size="sm" fw={600}>任务列表</Text>
        <Badge className="lens-asset-task-panel__count" variant="light" color="gray">{total}</Badge>
        <ActionIcon className="lens-asset-task-panel__refresh" variant="subtle" color="gray" aria-label="刷新任务列表"
          loading={loading} onClick={() => setRefresh((value) => value + 1)}>
          <IconRefresh className="lens-asset-task-panel__refresh-icon" size={16} />
        </ActionIcon>
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
        {records.map((record, index) => <AssetTaskPanelCard key={record.id || index} record={record} applicationName={resolveLensTaskApplicationName(record.originAppId, applications)} canViewParams={canViewParams}
          target={assetId && assetType !== undefined && dramaId ? { category: assetType + 1, entityId: assetId, dramaId,
            label: typeof data.label === 'string' && data.label ? data.label : '当前资产' } : undefined} />)}
      </div>
      {total > PAGE_SIZE && <Pagination className="lens-asset-task-panel__pagination" size="xs" siblings={0} boundaries={1}
        total={Math.ceil(total / PAGE_SIZE)} value={page} onChange={setPage} />}
    </aside>
  )
}
