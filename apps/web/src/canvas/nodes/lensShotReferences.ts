import type { Node } from '@xyflow/react'
import { addShotReferenceRelations, type LensAssetImage, type LensRole } from '../../api/lens'
import { useRFStore } from '../store'
import { resolveNodePrimaryImageUrl } from './taskNode/upstreamReferences'
import type { LensShotRef } from './LensShotNode'

/** 分类与 Lens 资产关联表一致。 */
export enum ReferenceCategory { Role = 1, Scene = 2, Prop = 3 }
export interface ReferenceAsset extends LensShotRef { parentId?: string; variantName?: string }
export interface ReferenceGroup { id: string; name: string; items: ReferenceAsset[] }
export const referenceKey = (item: LensShotRef): string => item.category + ':' + item.id

/** 分镜板同构分组：角色/子造型同组，场景/子场景同组，道具平铺。 */
export function groupReferenceAssets(category: ReferenceCategory, rows: LensRole[] | LensAssetImage[]): ReferenceGroup[] {
  const roles = rows as LensRole[]
  const images = rows as LensAssetImage[]
  const assets: ReferenceAsset[] = category === ReferenceCategory.Role
    ? roles.map((row) => ({ category, id: String(row.id), name: row.roleName || '未命名角色', imgUrl: row.threeImg, parentId: row.roleType === 1 && row.parentId ? String(row.parentId) : undefined, variantName: row.cloneName }))
    : images.map((row) => ({ category, id: String(row.id), name: row.name || '未命名资产', imgUrl: row.url, parentId: row.parentId ? String(row.parentId) : undefined, variantName: row.variantName }))
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
  const imgUrl = resolveNodePrimaryImageUrl(node)
  if (!imgUrl) throw new Error('所选节点尚无可用参考图片')
  return { category: entityId && [ReferenceCategory.Role, ReferenceCategory.Scene, ReferenceCategory.Prop].includes(category) ? category : 0,
    id: entityId || node.id, name: String(node.data.label || '参考图片'), imgUrl }
}

const savingTargets = new Set<string>()
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
  savingTargets.add(targetId)
  try {
    if (additions.length) await addShotReferenceRelations(dramaId, storyboardId, additions.map((asset) => ({ assetId: asset.id, assetCategory: asset.category })))
    // 等待期间目标可能卸载/切集：不把旧响应写到新画布。
    if (!useRFStore.getState().nodes.some((node) => node.id === targetId && node.data.entityId === target.data.entityId)) return
    unique.forEach((asset, index) => {
      let source = useRFStore.getState().nodes.find((node) => sourceNodeId ? node.id === sourceNodeId : Number(node.data.assetCategory) === asset.category && String(node.data.entityId) === asset.id)
      if (!source) {
        const before = new Set(useRFStore.getState().nodes.map((node) => node.id))
        useRFStore.getState().addNode('taskNode', asset.name, { kind: 'image', autoLabel: false, source: 'lens_projection', sourceProjectId: dramaId, entityId: asset.id,
          assetCategory: asset.category, imageUrl: asset.imgUrl, position: { x: target.position.x - 420, y: target.position.y + index * 240 } })
        source = useRFStore.getState().nodes.find((node) => !before.has(node.id))
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
