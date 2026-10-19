import { describe, expect, it } from 'vitest'
import { buildShotRefsFromAssets, refBadgeLabel } from '../../src/canvas/nodes/LensShotNode'
import type { LensAssetEnriched } from '../../src/api/lens'
describe('分镜引用显示名', () => {
  it('子角色与子场景角标分别显示「子角色」「子场景」，主资产仍显示角色/场景', () => {
    expect(refBadgeLabel({ category: 1, parentId: 'r1' })).toBe('子角色')
    expect(refBadgeLabel({ category: 1 })).toBe('角色')
    expect(refBadgeLabel({ category: 2, parentId: 's1' })).toBe('子场景')
    expect(refBadgeLabel({ category: 2 })).toBe('场景')
    expect(refBadgeLabel({ category: 3 })).toBe('道具')
  })
  it('子角色显示完整名称，说话者仍使用父角色基础名', () => {
    const assets: LensAssetEnriched[] = [
      { refId: '1', assetCategory: 1, roleId: 'r1', characterName: '方怡静', threeImg: '/main.png' },
      { refId: '1', assetCategory: 1, roleId: 'r2', parentId: 'r1', cloneName: '连衣裙', characterName: '方怡静（连衣裙）', threeImg: '/dress.png' },
    ]
    expect(buildShotRefsFromAssets(assets, '1', ['方怡静'])).toEqual([
      { category: 1, id: 'r1', name: '方怡静', imgUrl: '/main.png', baseName: '方怡静', isSpeaker: true },
      { category: 1, id: 'r2', name: '方怡静（连衣裙）', imgUrl: '/dress.png', baseName: '方怡静', parentId: 'r1', isSpeaker: true },
    ])
  })
  it('子场景显示父场景与特征完整名称，且不参与说话者判断', () => {
    const assets: LensAssetEnriched[] = [{ refId: '9', assetCategory: 2, assetId: 's2', parentId: 's1', variantName: '夜晚', subType: 'time', imgName: '街道（夜晚）', imgUrl: '/night.png' }]
    const [ref] = buildShotRefsFromAssets(assets, '9', ['街道'])
    expect(ref).toEqual({ category: 2, id: 's2', name: '街道（夜晚）', imgUrl: '/night.png', parentId: 's1', isSpeaker: false })
    expect(refBadgeLabel(ref)).toBe('子场景')
  })
  it('只返回当前分镜的引用', () => {
    const assets: LensAssetEnriched[] = [{ refId: '1', assetCategory: 3, assetId: 'p1', imgName: '雨伞', imgUrl: '/umbrella.png' }]
    expect(buildShotRefsFromAssets(assets, '2', [])).toEqual([])
  })
})
