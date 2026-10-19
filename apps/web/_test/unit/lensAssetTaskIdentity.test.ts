import { describe, expect, it } from 'vitest'
import { readLensAssetTaskIdentity } from '../../src/canvas/utils/lensAssetTaskIdentity'

describe('资产生图任务身份', () => {
  it.each([[1, 0], [2, 1], [3, 2]])('资产分类 %s 对应任务类型 %s', (assetCategory, assetType) => {
    expect(readLensAssetTaskIdentity({ assetCategory, entityId: '123' })).toEqual({ assetId: '123', assetType })
  })
  it('子造型和子场景使用自身ID，不使用父级ID', () => {
    for (const assetCategory of [1, 2]) {
      expect(readLensAssetTaskIdentity({ assetCategory, entityId: '9223372036854775806', parentEntityId: '100' })?.assetId).toBe('9223372036854775806')
    }
  })
  it('自由生图节点不提供资产任务身份', () => {
    expect(readLensAssetTaskIdentity({ canvasNodeAssetId: 123, entityId: '123' })).toBeNull()
  })
  it.each(['', '0', '-1', '1.2', 'abc', undefined, 9007199254740992])('拒绝无效资产ID %s，避免查询全量或串资产', (entityId) => {
    expect(readLensAssetTaskIdentity({ assetCategory: 1, entityId })).toBeNull()
  })
})
