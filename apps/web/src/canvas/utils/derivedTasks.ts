import {
  CANVAS_NODE_ASSET_TYPE,
  LensAssetTaskStatus,
  listCanvasFreeNodeTasks,
  type LensTaskRecord,
} from '../../api/lens'
import { useRFStore } from '../store'
import { getEditTypeLabel, getNodeWithDerivatives } from './node'

/** 批量查衍生任务时单次请求的行数上限（节点多时按节点数放大，但不能无限大） */
const MAX_BATCH_TASK_PAGE_SIZE = 500
/** 每个衍生节点默认分配的任务行数（与原资产任务分页口径一致） */
const PER_NODE_TASK_PAGE_SIZE = 20

/** 衍生节点任务行：在原任务记录上附加来源标签 */
export type DerivedTaskRecord = LensTaskRecord & { derivedLabel?: string }

/**
 * 过滤掉节点入画布之前的任务。
 *
 * <p>历史遗留：早期节点数字ID 用「当前最大值 +1」分配，删掉最大编号的节点后会回退并复用，
 * 复用后旧节点的历史任务仍挂在同一 assetId 下，不过滤就会串到新节点上。
 * 现在新节点改用时间戳量级ID（allocateCanvasNodeAssetId）不会再复用，
 * 本过滤只用于兜住历史数据；老节点没有 nodeCreatedAt 时无法判定归属，原样返回。
 *
 * @param rows 任务行
 * @param nodeCreatedAt 节点入画布时间（ISO 字符串）
 * @returns 节点存在期间产生的任务
 */
export function filterTasksAfterNodeCreated<T extends { createTime?: string }>(rows: T[], nodeCreatedAt: unknown): T[] {
  const createdAtMs = typeof nodeCreatedAt === 'string' ? new Date(nodeCreatedAt).getTime() : Number.NaN
  if (!Number.isFinite(createdAtMs)) return rows
  return rows.filter((row) => {
    const createdMs = row.createTime ? new Date(row.createTime).getTime() : Number.NaN
    // 时间解析失败时保留：宁可多显示，也不要把真任务藏起来
    return !Number.isFinite(createdMs) || createdMs >= createdAtMs
  })
}

/**
 * 按任务状态筛选（口径与业务资产任务一致：默认隐藏失败）。
 *
 * @param rows 任务行
 * @param matchStatus 目标状态
 * @returns 命中状态的任务行
 */
function filterByStatus<T extends LensTaskRecord>(rows: T[], matchStatus: LensAssetTaskStatus): T[] {
  return rows.filter((row) => {
    const status = row.taskStatus || row.status
    return matchStatus === LensAssetTaskStatus.All ? status !== 'FAILED' : status === matchStatus
  })
}

/**
 * 收集某个业务资产节点衍生出的图片编辑节点任务。
 *
 * <p>衍生节点是画布自由节点，任务归属为 sceneId(画布flowId)+assetType=10+assetId(节点数字ID)，
 * 与角色/场景/道具的实体ID口径不同，必须单独查询再合并展示。识别衍生关系用的是
 * 「来源节点 → 衍生节点」连线 + refNodeId 兜底（旧数据没有 refNodeId，只能靠连线）。
 *
 * <p>多个衍生节点用一次 {@code asset_id IN (...)} 批量查询取回，避免 N 次网络往返；
 * 返回行的 assetId 用于把任务精确分组回各衍生节点。
 *
 * @param params 剧ID、画布flowId、来源节点ID、状态筛选
 * @returns 打上来源标签的衍生节点任务行（已按状态筛选）
 */
export async function collectDerivedTaskRows(params: {
  dramaId: string
  flowId: number
  nodeId: string
  matchStatus: LensAssetTaskStatus
}): Promise<DerivedTaskRecord[]> {
  const { dramaId, flowId, nodeId, matchStatus } = params
  const storeState = useRFStore.getState()
  // 画布 store 的节点数据类型比 getNodeWithDerivatives 的泛型更宽，这里按需读出 id/type/data 后交给纯函数识别
  const allNodes = storeState.nodes.map((node) => ({
    id: node.id,
    type: node.type,
    data: node.data as Record<string, unknown> | undefined,
  }))
  const { derivedNodeIds } = getNodeWithDerivatives(
    nodeId,
    allNodes as unknown as Parameters<typeof getNodeWithDerivatives>[1],
    storeState.edges,
  )
  // 先把每个衍生节点的「数字ID → 节点」建好，用于回填来源标签与入画布时间过滤
  const nodeByAssetId = new Map<number, (typeof allNodes)[number]>()
  for (const derivedNodeId of derivedNodeIds) {
    const derivedNode = allNodes.find((node) => node.id === derivedNodeId)
    const derivedAssetId = Number(derivedNode?.data?.canvasNodeAssetId)
    if (Number.isFinite(derivedAssetId) && derivedAssetId > 0) nodeByAssetId.set(derivedAssetId, derivedNode!)
  }
  if (nodeByAssetId.size === 0) return []

  const derivedRes = await listCanvasFreeNodeTasks({
    dramaId,
    sceneId: flowId,
    assetType: CANVAS_NODE_ASSET_TYPE,
    assetIds: Array.from(nodeByAssetId.keys()),
    pageNum: 1,
    pageSize: Math.min(PER_NODE_TASK_PAGE_SIZE * nodeByAssetId.size, MAX_BATCH_TASK_PAGE_SIZE),
  })
  const rows: DerivedTaskRecord[] = []
  for (const row of Array.isArray(derivedRes.rows) ? derivedRes.rows : []) {
    // 后端 selectLensApplicationTaskList 会带回 tqueue.asset_id，按它把任务分组回节点
    const derivedNode = nodeByAssetId.get(Number(row.assetId))
    if (!derivedNode) continue
    const afterCreated = filterTasksAfterNodeCreated([row], derivedNode.data?.nodeCreatedAt)
    if (afterCreated.length === 0) continue
    if (filterByStatus([row], matchStatus).length === 0) continue
    rows.push({ ...row, derivedLabel: getEditTypeLabel(String(derivedNode.data?.editType || '')) || '衍生节点' })
  }
  return rows
}
