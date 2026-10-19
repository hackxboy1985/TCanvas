import { describe, expect, it } from 'vitest'
import {
  collectNodeReferenceImageUrls,
  readNodeFirstFrameUrl,
  readNodeLastFrameUrl,
} from '../../src/runner/nodeReferenceInputs'

describe('nodeReferenceInputs', () => {
  it('collects executable reference urls from referenceImages, anchorBindings, roleCardReferenceImages, and assetInputs', () => {
    expect(
      collectNodeReferenceImageUrls({
        referenceImages: [
          'https://example.com/ref-a.png',
          'https://example.com/ref-a.png',
          'not-a-url',
        ],
        anchorBindings: [
          {
            kind: 'character',
            label: '方源',
            imageUrl: 'https://example.com/ref-d.png',
          },
        ],
        roleCardReferenceImages: [
          'https://example.com/ref-c.png',
          'https://example.com/ref-c.png',
        ],
        assetInputs: [
          { url: 'https://example.com/ref-b.png', role: 'reference' },
          { url: 'https://example.com/ref-a.png', role: 'character' },
          { url: '' },
        ],
      }),
    ).toEqual([
      'https://example.com/ref-a.png',
      'https://example.com/ref-d.png',
      'https://example.com/ref-c.png',
      'https://example.com/ref-b.png',
    ])
  })

  it('主角色节点不带自身旧图：自身锚点绑定被排除', () => {
    // 主角色投影节点：anchorBindings 绑定的是自己（entityId=4258），imageUrl 是资产已有图。
    // 重新生成时本节点没有上游参考，不能把自身旧图当参考图下发。
    expect(
      collectNodeReferenceImageUrls({
        entityId: '4258',
        anchorBindings: [
          { kind: 'character', entityId: '4258', imageUrl: 'https://example.com/self-old.png' },
        ],
      }),
    ).toEqual([])
  })

  it('子角色/子场景同样排除自身旧图（父图由上游连线提供，不在此特殊处理）', () => {
    // 子角色（entityId=5001）绑定自己的那条是自身旧图 → 排除。
    // 父子关系靠画布的「父→子派生连线」进入上游参考区，与其它上游参考统一，
    // 因此这里即便出现父实体绑定也不依赖它。
    expect(
      collectNodeReferenceImageUrls({
        entityId: '5001',
        anchorBindings: [
          { kind: 'character', entityId: '5001', imageUrl: 'https://example.com/child-old.png' },
        ],
      }),
    ).toEqual([])

    expect(
      collectNodeReferenceImageUrls({
        entityId: '8801',
        anchorBindings: [
          { kind: 'scene', entityId: '8801', imageUrl: 'https://example.com/subscene-old.png' },
        ],
      }),
    ).toEqual([])
  })

  it('参考区确实添加了图时，即便等于自身旧图也必须提交', () => {
    // 用户在参考区手动加图 → 写入 referenceImages，必须原样提交任务，不受自动过滤影响
    expect(
      collectNodeReferenceImageUrls({
        entityId: '4258',
        referenceImages: ['https://example.com/self-old.png'],
        anchorBindings: [
          { kind: 'character', entityId: '4258', imageUrl: 'https://example.com/self-old.png' },
        ],
      }),
    ).toEqual(['https://example.com/self-old.png'])
  })

  it('reads generic and vendor-specific frame urls', () => {
    expect(
      readNodeFirstFrameUrl({
        firstFrameUrl: 'https://example.com/first.png',
        veoFirstFrameUrl: 'https://example.com/ignored.png',
      }),
    ).toBe('https://example.com/first.png')

    expect(
      readNodeLastFrameUrl({
        veoLastFrameUrl: 'https://example.com/last.png',
      }),
    ).toBe('https://example.com/last.png')
  })
})
