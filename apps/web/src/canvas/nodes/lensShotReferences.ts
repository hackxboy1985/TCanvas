import type { Node } from '@xyflow/react'
import { addShotReferenceRelations, listReferenceAssets, removeShotReferenceRelations, type LensAssetImage, type LensRole } from '../../api/lens'
import { useRFStore } from '../store'
import { pickPrimaryImageFromNode } from './taskNode/upstreamReferences'
import type { LensShotRef } from './LensShotNode'
import { LENS_ASSET_MEDIA_HEIGHT, LENS_ASSET_NODE_WIDTH } from '../../projects/lensCanvasNodeLayout'

/**
 * 分类与 Lens 资产关联表一致。
 *
 * <p>Staging=4 对应 lens_asset_image 的 type=3（站位图），
 * 与 RuoYi 分镜板「选择站位图」弹窗的数据源完全一致。</p>
 */
export enum ReferenceCategory { Role = 1, Scene = 2, Prop = 3, Staging = 4 }
export interface ReferenceAsset extends LensShotRef { parentId?: string; variantName?: string; subType?: string; state?: number }
export interface ReferenceGroup { id: string; name: string; items: ReferenceAsset[] }
export const referenceKey = (item: LensShotRef): string => item.category + ':' + item.id

/** 新增资产节点的横向偏移：与首列角色节点保持固定间距；与投影节点同样统一 384 宽、250 高图片区。 */
const NEW_ASSET_NODE_OFFSET_X = 440
/** 新增资产节点纵向间距：节点总高约 294，留 36 空白，避免重叠。 */
const NEW_ASSET_NODE_GAP_Y = 330

/** 分镜板同构分组：角色/子造型同组，场景/子场景同组，道具平铺。 */
export function groupReferenceAssets(category: ReferenceCategory, rows: LensRole[] | LensAssetImage[]): ReferenceGroup[] {
  const roles = rows as LensRole[]
  const images = rows as LensAssetImage[]
  const assets: ReferenceAsset[] = category === ReferenceCategory.Role
    ? roles.map((row) => ({ category, id: String(row.id), name: row.roleName || '未命名角色', imgUrl: row.threeImg, parentId: row.roleType === 1 && row.parentId ? String(row.parentId) : undefined, variantName: row.cloneName }))
    : images.map((row) => ({ category, id: String(row.id), name: row.name || '未命名资产', imgUrl: row.url, parentId: row.parentId ? String(row.parentId) : undefined, variantName: row.variantName, subType: row.subType, ...(typeof row.state === 'number' ? { state: row.state } : null) }))
  const groups = new Map<string, ReferenceGroup>()
  assets.forEach((asset) => {
    const groupId = asset.parentId || asset.id
    const main = assets.find((candidate) => candidate.id === groupId)
    const group = groups.get(groupId) || { id: groupId, name: main?.name || asset.name, items: [] }
    group.items.push(asset)
    groups.set(groupId, group)
  })
  return Array.from(groups.values()).map((group) => ({ ...group, items: group.items.sort((a, b) => Number(Boolean(a.parentId)) - Number(Boolean(b.parentId))) }))
}

/** 从业务投影或普通图片节点提取引用身份；普通图片仅通过连线编排。 */
export function referenceFromNode(node: Node): ReferenceAsset {
  const category = Number(node.data.assetCategory)
  const entityId = String(node.data.entityId || '')
  const imgUrl = pickPrimaryImageFromNode(node)
  if (!imgUrl) throw new Error('所选节点尚无可用参考图片')
  // 子造型/子场景名取自节点数据（投影/资产库建节点写入 variantName|cloneName），父级ID取 parentEntityId
  const childName = String(node.data.variantName || node.data.cloneName || node.data.childName || '').trim()
  const parentEntityId = String(node.data.parentEntityId || '').trim()
  return { category: entityId && [ReferenceCategory.Role, ReferenceCategory.Scene, ReferenceCategory.Prop, ReferenceCategory.Staging].includes(category) ? category : 0,
    id: entityId || node.id, name: String(node.data.label || '参考图片'), imgUrl,
    ...(childName ? { variantName: childName } : null),
    ...(parentEntityId ? { parentId: parentEntityId } : null) }
}

const savingTargets = new Set<string>()

/**
 * 找出「被引用的子资产，其父资产不在画布中」的孤儿父级。
 *
 * <p><b>为什么需要</b>：在分镜节点里添加某个角色的子造型（分身）/子场景时，
 * 其主角色/主场景可能还不在画布上（本集分镜没引用过它）。此时画布不会生成
 * 「父→子派生连线」，子节点的底部参考区就没有父图可展示。
 *
 * <p><b>只为连线服务</b>：按方案 A，仅补建被孤儿引用到的父级，不做全量资产投影。
 *
 * @param nodes 画布现有节点
 * @param assets 本次要添加的参考资产（含 parentId）
 * @param dramaId 剧ID，用于过滤属于本剧的父级
 * @returns 缺失的父级标识（category + parentId 去重）
 */
function collectMissingParents(
  nodes: Node[],
  assets: ReferenceAsset[],
  dramaId: string,
): Array<{ category: ReferenceCategory; parentId: string; onCanvas: boolean }> {
  const out: Array<{ category: ReferenceCategory; parentId: string; onCanvas: boolean }> = []
  const seen = new Set<string>()
  for (const asset of assets) {
    const parentId = String(asset.parentId ?? '').trim()
    // 道具没有父子层级；无 parentId 表示资产本身就是主身份
    if (!parentId || asset.category === ReferenceCategory.Prop) continue
    const key = asset.category + ':' + parentId
    if (seen.has(key)) continue
    seen.add(key)
    // onCanvas=true 表示主身份已在画布上：不新建节点，但仍需补连接线与子节点
    const onCanvas = nodes.some(
      (node) => Number(node.data.assetCategory) === asset.category
        && String(node.data.entityId || '') === parentId
        // 补建节点必须属于当前剧，避免把别的剧的资产挂到本画布
        && (!node.data.sourceProjectId || String(node.data.sourceProjectId) === dramaId),
    )
    out.push({ category: asset.category, parentId, onCanvas })
  }
  return out
}

/**
 * 补建「被孤立引用的父级」节点，并建立父→子连线。
 *
 * <p><b>场景</b>：在分镜节点里添加某角色的子造型（分身）/ 某场景的子场景时，
 * 其主角色 / 主场景可能不在画布上（本集分镜没引用过它）。此时子节点与父节点之间
 * 没有连线，子节点底部参考区展示不出父图，也无法把父图带进生成任务。
 *
 * <p><b>做法（方案 A：只补孤儿父级）</b>：只针对本次添加的子资产查询其父级信息，
 * 补建父节点并连一条 父→子 的派生连线，与投影阶段的 `edge-derived-*` 语义一致。
 * 不做全量资产投影，避免把本集未涉及的资产都铺到画布上。
 *
 * <p><b>父图只用于参考，不进 refs</b>：父级并未被分镜引用，因此不写 refs、
 * 不建「父→分镜」连线，避免凭空给分镜增加业务关联。
 *
 * @param dramaId 剧ID
 * @param targetPosition 当前分镜节点位置，父节点参考此位置摆放在其左上方
 * @param assets 本次添加的参考资产（含 parentId）
 * @returns 本次补建的「父节点ID → 子节点ID」连线列表（子节点此时可能尚未创建，由调用方创建后再连）
 */
async function ensureMissingParentsOnCanvas(
  dramaId: string,
  targetPosition: { x: number; y: number },
  assets: ReferenceAsset[],
): Promise<Array<{ parentNodeId: string; childNodeId: string }>> {
  const parents = collectMissingParents(useRFStore.getState().nodes, assets, dramaId)
  if (!parents.length) return []
  const pendingEdges: Array<{ parentNodeId: string; childNodeId: string }> = []
  // 只有「父级不在画布上」的才需要查库补建；已在画布的直接补连线
  const needFetch = parents.filter((item) => !item.onCanvas)
  const byCategory = new Map<ReferenceCategory, string[]>()
  for (const item of needFetch) {
    const list = byCategory.get(item.category) ?? []
    list.push(item.parentId)
    byCategory.set(item.category, list)
  }
  // 跨类别累计竖直偏移：角色与场景的父节点都补在分镜左侧，
  // 若各自从 0 计数会叠在同一个位置。
  let placedCount = 0
  for (const [category, parentIds] of byCategory) {
    const rows = await listReferenceAssets<LensRole & LensAssetImage>(dramaId, category)
    parentIds.forEach((parentId) => {
      const row = rows.find((candidate) => String(candidate.id) === parentId)
      if (!row) return
      // 角色取三视图、场景/道具取 url，与投影节点的取图口径保持一致
      const imgUrl = category === ReferenceCategory.Role
        ? String((row as LensRole).threeImg || '')
        : String((row as LensAssetImage).url || '')
      // 没有图的父级补出来也是个空节点，不制造无效节点
      if (!imgUrl) return
      const name = String((row as LensRole).roleName || (row as LensAssetImage).name || '')
      const prefix = category === ReferenceCategory.Role ? 'role' : 'scene'
      const parentNodeId = prefix + '-' + parentId
      if (!useRFStore.getState().nodes.some((node) => node.id === parentNodeId)) {
        const offsetIndex = placedCount
        placedCount += 1
        // ID 与投影节点保持一致，重新打开画布时可由业务快照直接复用同一条节点
        useRFStore.setState((current) => ({
          nodes: [...current.nodes, {
            id: parentNodeId,
            type: 'taskNode',
            position: {
              x: targetPosition.x - NEW_ASSET_NODE_OFFSET_X,
              y: targetPosition.y - NEW_ASSET_NODE_GAP_Y * (offsetIndex + 1),
            },
            data: {
              label: name, kind: 'image', source: 'lens_projection', sourceProjectId: dramaId,
              entityId: parentId, assetCategory: category, imageUrl: imgUrl,
              nodeWidth: LENS_ASSET_NODE_WIDTH, nodeHeight: LENS_ASSET_MEDIA_HEIGHT,
            },
          }],
        }))
      }
    })
  }
  // 统一登记待建连线：父级可能是本次新建的，也可能是画布上早就有的。
  // 后者以前会被直接跳过，导致「主角色已在画布但和子角色没连线」的问题。
  for (const item of parents) {
    const child = assets.find((candidate) => candidate.category === item.category && String(candidate.parentId ?? '') === item.parentId)
    if (!child) continue
    const prefix = item.category === ReferenceCategory.Role ? 'role' : 'scene'
    pendingEdges.push({ parentNodeId: prefix + '-' + item.parentId, childNodeId: prefix + '-' + child.id })
  }
  return pendingEdges
}

/**
 * 建立「父→子派生连线」，让子节点参考区能显示父图。
 *
 * @param pendingEdges 需要建立的父子连线
 */
function connectParentChildEdges(pendingEdges: Array<{ parentNodeId: string; childNodeId: string }>): void {
  if (!pendingEdges.length) return
  for (const item of pendingEdges) {
    const store = useRFStore.getState()
    // 子节点尚未落地（如业务关联失败）时跳过，不留无效连线
    if (!store.nodes.some((node) => node.id === item.childNodeId)) continue
    if (store.edges.some((edge) => edge.source === item.parentNodeId && edge.target === item.childNodeId)) continue
    store.onConnect({ source: item.parentNodeId, sourceHandle: 'out-image', target: item.childNodeId, targetHandle: null })
  }
}

/** 先删除业务关联，再同步移除本地引用及该资产指向分镜的连线。 */
export async function disconnectShotReference(targetId: string, ref: LensShotRef): Promise<void> {
  if (savingTargets.has(targetId)) throw new Error('参考正在保存，请稍候')
  const state = useRFStore.getState()
  const target = state.nodes.find((node) => node.id === targetId)
  if (!target) throw new Error('目标分镜已不存在')
  const dramaId = String(target.data.sourceProjectId || '')
  const storyboardId = String(target.data.entityId || '')
  if (!dramaId || !storyboardId) throw new Error('缺少剧集或分镜身份，无法删除参考')
  savingTargets.add(targetId)
  try {
    await removeShotReferenceRelations(dramaId, storyboardId, [{ assetId: ref.id, assetCategory: ref.category }])
    const latest = useRFStore.getState()
    const latestTarget = latest.nodes.find((node) => node.id === targetId && String(node.data.entityId) === storyboardId && String(node.data.sourceProjectId) === dramaId)
    if (!latestTarget) return
    const refs = (Array.isArray(latestTarget.data.refs) ? latestTarget.data.refs : []) as LensShotRef[]
    const remaining = refs.filter((item) => referenceKey(item) !== referenceKey(ref))
    // 后端删除角色引用会清理说话者，本地同步清理，避免留下说话者标记。
    const speakerName = String(latestTarget.data.speakerName || '').split(',').filter((name) => name.trim() && (ref.category !== ReferenceCategory.Role || name.trim() !== ref.name)).join(',')
    latest.updateNodeData(targetId, { refs: remaining, speakerName })
    const sourceIds = new Set(latest.nodes.filter((node) => Number(node.data.assetCategory) === ref.category && String(node.data.entityId) === ref.id).map((node) => node.id))
    latest.edges.filter((edge) => edge.target === targetId && sourceIds.has(edge.source)).forEach((edge) => latest.deleteEdge(edge.id))
  } finally { savingTargets.delete(targetId) }
}

/** 业务关联成功后再补节点和连线，禁止把业务资产副本持久化到 flow。 */
export async function connectShotReferences(targetId: string, assets: ReferenceAsset[], sourceNodeId?: string): Promise<void> {
  if (savingTargets.has(targetId)) throw new Error('参考正在保存，请稍候')
  const state = useRFStore.getState()
  const target = state.nodes.find((node) => node.id === targetId)
  if (!target) throw new Error('目标分镜已不存在')
  const dramaId = String(target.data.sourceProjectId || '')
  const storyboardId = String(target.data.entityId || '')
  if (!dramaId || !storyboardId) throw new Error('缺少剧集或分镜身份，无法保存参考')
  if (assets.some((asset) => !asset.imgUrl)) throw new Error('所选资产尚无参考图片')
  const currentRefs = (Array.isArray(target.data.refs) ? target.data.refs : []) as LensShotRef[]
  const existing = new Set(currentRefs.map(referenceKey))
  const unique = Array.from(new Map(assets.map((asset) => [referenceKey(asset), asset])).values())
  const additions = unique.filter((asset) => asset.category > 0 && !existing.has(referenceKey(asset)))
  if (sourceNodeId) {
    const source = state.nodes.find((node) => node.id === sourceNodeId)
    if (!source || (source.data.sourceProjectId && String(source.data.sourceProjectId) !== dramaId)) throw new Error('参考节点不属于当前剧集')
    const reachable = [targetId]
    const visited = new Set<string>()
    while (reachable.length) {
      const next = reachable.pop()
      if (!next || visited.has(next)) continue
      if (next === sourceNodeId) throw new Error('该连接会形成循环')
      visited.add(next)
      state.edges.filter((edge) => edge.source === next).forEach((edge) => reachable.push(edge.target))
    }
  }
  savingTargets.add(targetId)
  try {
    if (additions.length) await addShotReferenceRelations(dramaId, storyboardId, additions.map((asset) => ({ assetId: asset.id, assetCategory: asset.category })))
    // 等待期间目标可能卸载/切集：不把旧响应写到新画布。
    if (!useRFStore.getState().nodes.some((node) => node.id === targetId && node.data.entityId === target.data.entityId)) return
    // 补建孤儿父级：添加子造型/子场景时，其主身份可能还不在画布上。
    // 不补的话，父→子派生连线无从建立，子节点参考区就没有父图可显示。
    // 连线必须等子节点创建后再建，因此先暂存。
    const pendingParentEdges = await ensureMissingParentsOnCanvas(dramaId, target.position, unique)
    unique.forEach((asset, index) => {
      let source = useRFStore.getState().nodes.find((node) => sourceNodeId ? node.id === sourceNodeId : Number(node.data.assetCategory) === asset.category && String(node.data.entityId) === asset.id)
      if (!source) {
        // 使用投影相同的稳定 ID，重新打开后由业务快照补齐展示字段。
        const prefix = asset.category === ReferenceCategory.Role
          ? 'role'
          : asset.category === ReferenceCategory.Scene
            ? 'scene'
            : asset.category === ReferenceCategory.Staging
              ? 'staging'
              : 'prop'
        // 尺寸与主画布投影一致，否则节点按 TaskNode 默认尺寸渲染，底部工具栏会被算到很远处。
        source = { id: prefix + '-' + asset.id, type: 'taskNode', position: { x: target.position.x - NEW_ASSET_NODE_OFFSET_X, y: target.position.y + index * NEW_ASSET_NODE_GAP_Y },
          data: { label: asset.name, kind: 'image', source: 'lens_projection', sourceProjectId: dramaId, entityId: asset.id,
            assetCategory: asset.category, imageUrl: asset.imgUrl, nodeWidth: LENS_ASSET_NODE_WIDTH, nodeHeight: LENS_ASSET_MEDIA_HEIGHT,
            // 子造型/子场景名写进节点数据：之后从画布再选该节点作参考时，靠它还原参考卡片顶部的子造型名
            ...(asset.variantName ? { childName: asset.variantName } : null) } }
        const newNode = source
        useRFStore.setState((current) => ({ nodes: [...current.nodes, newNode] }))
      }
      if (!source) throw new Error('创建参考节点失败')
      const store = useRFStore.getState()
      if (!store.edges.some((edge) => edge.source === source.id && edge.target === targetId)) {
        store.onConnect({ source: source.id, sourceHandle: 'out-image', target: targetId, targetHandle: null })
      }
    })
    // 子节点已创建，补建「父→子」派生连线
    connectParentChildEdges(pendingParentEdges)
    const latest = useRFStore.getState().nodes.find((node) => node.id === targetId)
    const refs = (Array.isArray(latest?.data.refs) ? latest.data.refs : []) as LensShotRef[]
    const merged = new Map(refs.map((ref) => [referenceKey(ref), ref]))
    // 带上主名与子造型名：存在时以它们为准，避免底部参考卡片再去反推完整名里的括号
    additions.forEach((asset) => merged.set(referenceKey(asset), { category: asset.category, id: asset.id, name: asset.name, imgUrl: asset.imgUrl,
      ...(asset.variantName ? { variantName: asset.variantName } : null) }))
    useRFStore.getState().updateNodeData(targetId, { refs: Array.from(merged.values()) })
  } finally { savingTargets.delete(targetId) }
}
