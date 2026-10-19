import { useRFStore } from '../store'
import { readLensAssetTaskIdentity } from './lensAssetTaskIdentity'
import type { LensAssetTaskAdoptionTarget } from '../../api/lens'

/** 业务表关联成功后同步同一资产的运行态投影；保留原候选、提示词及编排，不扩大flow白名单。 */
export function syncLensAssetTaskImage(target: LensAssetTaskAdoptionTarget, imageUrl: string): void {
  const dramaId = new URLSearchParams(window.location.search).get('dramaId')
  if (dramaId !== target.dramaId) return
  useRFStore.setState((state) => ({ nodes: state.nodes.map((node) => {
    const data = node.data as Record<string, unknown>
    const identity = readLensAssetTaskIdentity(data)
    if (identity?.assetId !== target.entityId || data.assetCategory !== target.category) return node
    const previous = Array.isArray(data.imageResults) ? data.imageResults : typeof data.imageUrl === 'string' && data.imageUrl ? [{ url: data.imageUrl }] : []
    const results: unknown[] = [...previous]
    let index = results.findIndex((item) => !!item && typeof item === 'object' && 'url' in item && item.url === imageUrl)
    if (index < 0) { index = results.length; results.push({ url: imageUrl }) }
    const anchorBindings = Array.isArray(data.anchorBindings) ? data.anchorBindings.map((binding: unknown) =>
      binding && typeof binding === 'object' && 'entityId' in binding && String(binding.entityId) === target.entityId
        ? { ...binding, imageUrl } : binding) : data.anchorBindings
    return { ...node, data: { ...data, imageUrl, imageResults: results, imagePrimaryIndex: index,
      ...(anchorBindings ? { anchorBindings } : {}) } }
  }) }))
}
