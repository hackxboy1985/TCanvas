import type { Node } from '@xyflow/react'
import { addShotReferenceRelations, removeShotReferenceRelations, type LensAssetImage, type LensRole } from '../../api/lens'
import { useRFStore } from '../store'
import { pickPrimaryImageFromNode } from './taskNode/upstreamReferences'
import type { LensShotRef } from './LensShotNode'
import { LENS_ASSET_MEDIA_HEIGHT, LENS_ASSET_NODE_WIDTH } from '../../projects/lensCanvasNodeLayout'

/** 分类与 Lens 资产关联表一致。 */
export enum ReferenceCategory { Role = 1, Scene = 2, Prop = 3 }
export interface ReferenceAsset extends LensShotRef { parentId?: string; variantName?: string; subType?: string }
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
    : images.map((row) => ({ category, id: String(row.id), name: row.name || '未命名资产', imgUrl: row.url, parentId: row.parentId ? String(row.parentId) : undefined, variantName: row.variantName, subType: row.subType }))
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
  return { category: entityId && [ReferenceCategory.Role, ReferenceCategory.Scene, ReferenceCategory.Prop].includes(category) ? category : 0,
    id: entityId || node.id, name: String(node.data.label || '参考图片'), imgUrl }
}

const savingTargets = new Set<string>()

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
    unique.forEach((asset, index) => {
      let source = useRFStore.getState().nodes.find((node) => sourceNodeId ? node.id === sourceNodeId : Number(node.data.assetCategory) === asset.category && String(node.data.entityId) === asset.id)
      if (!source) {
        // 使用投影相同的稳定 ID，重新打开后由业务快照补齐展示字段。
        const prefix = asset.category === ReferenceCategory.Role ? 'role' : asset.category === ReferenceCategory.Scene ? 'scene' : 'prop'
        // 尺寸与主画布投影一致，否则节点按 TaskNode 默认尺寸渲染，底部工具栏会被算到很远处。
        source = { id: prefix + '-' + asset.id, type: 'taskNode', position: { x: target.position.x - NEW_ASSET_NODE_OFFSET_X, y: target.position.y + index * NEW_ASSET_NODE_GAP_Y },
          data: { label: asset.name, kind: 'image', source: 'lens_projection', sourceProjectId: dramaId, entityId: asset.id,
            assetCategory: asset.category, imageUrl: asset.imgUrl, nodeWidth: LENS_ASSET_NODE_WIDTH, nodeHeight: LENS_ASSET_MEDIA_HEIGHT } }
        const newNode = source
        useRFStore.setState((current) => ({ nodes: [...current.nodes, newNode] }))
      }
      if (!source) throw new Error('创建参考节点失败')
      const store = useRFStore.getState()
      if (!store.edges.some((edge) => edge.source === source.id && edge.target === targetId)) {
        store.onConnect({ source: source.id, sourceHandle: 'out-image', target: targetId, targetHandle: null })
      }
    })
    const latest = useRFStore.getState().nodes.find((node) => node.id === targetId)
    const refs = (Array.isArray(latest?.data.refs) ? latest.data.refs : []) as LensShotRef[]
    const merged = new Map(refs.map((ref) => [referenceKey(ref), ref]))
    additions.forEach((asset) => merged.set(referenceKey(asset), { category: asset.category, id: asset.id, name: asset.name, imgUrl: asset.imgUrl }))
    useRFStore.getState().updateNodeData(targetId, { refs: Array.from(merged.values()) })
  } finally { savingTargets.delete(targetId) }
}
