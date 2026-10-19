/** 资产分类与任务资产类型分属两个后端枚举，集中映射避免混用。 */
export const LENS_ASSET_TASK_TYPES = { 1: 0, 2: 1, 3: 2 } as const

/** 读取业务资产自身的任务查询身份；子资产不使用父资产 ID，自由节点不参与。 */
export function readLensAssetTaskIdentity(data: Record<string, unknown>): { assetId: string; assetType: number } | null {
  const category = data.assetCategory
  if (category !== 1 && category !== 2 && category !== 3) return null
  const assetId = typeof data.entityId === 'string' ? data.entityId.trim()
    : typeof data.entityId === 'number' && Number.isSafeInteger(data.entityId) ? String(data.entityId) : ''
  // 业务主键始终保持字符串，避免 Long 主键在 Number 转换时丢失精度。
  if (!/^[1-9]\d*$/.test(assetId)) return null
  return { assetId, assetType: LENS_ASSET_TASK_TYPES[category] }
}
