import { afterEach, describe, expect, it, vi } from 'vitest'
import { associateLensAssetTaskResult } from '../../src/api/lens'
import { syncLensAssetTaskImage } from '../../src/canvas/utils/lensAssetTaskAdoption'
import { useRFStore } from '../../src/canvas/store'

const image = 'https://example.test/original.png'
const target = { category: 1, entityId: '4258', dramaId: '738', label: '当前角色' }
afterEach(() => { vi.unstubAllGlobals(); useRFStore.setState({ nodes: [], edges: [] }) })
describe('任务结果关联业务资产', () => {
  it.each([1, 2, 3])('分类 %s 使用准确接口与字段，主键保留字符串', async (category) => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 200 })))
    vi.stubGlobal('fetch', fetch)
    await associateLensAssetTaskResult({ ...target, category }, image)
    expect(fetch.mock.calls[0][0]).toBe(category === 1 ? '/api/lensRole?as=lens' : '/api/lensImage?as=lens')
    expect(fetch.mock.calls[0][1].method).toBe('PUT')
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(category === 1
      ? { id: '4258', dramaId: '738', threeImg: image, modifySource: 'task_associate' }
      : { id: '4258', joinId: '738', url: image, modifySource: 'task_associate' })
  })
  it('权限或业务错误不能当作关联成功', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 403, msg: '无权修改该资产' }))))
    await expect(associateLensAssetTaskResult(target, image)).rejects.toThrow('无权修改该资产')
  })
  it('无业务身份或本地图片不发请求', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await expect(associateLensAssetTaskResult({ ...target, entityId: '' }, image)).rejects.toThrow()
    await expect(associateLensAssetTaskResult(target, 'blob:https://example.test/123')).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })
  it('仅同步自身资产并保留历史候选、父资产与提示词', () => {
    window.history.replaceState(null, '', '/canvas/?dramaId=738')
    const original = 'https://example.test/old.png'
    useRFStore.setState({ nodes: [
      { id: 'child', type: 'taskNode', position: { x: 1, y: 2 }, data: { assetCategory: 1, entityId: '4258', parentEntityId: '4000', imageUrl: original, prompt: '原提示词', anchorBindings: [{ entityId: '4258', imageUrl: original }] } },
      { id: 'parent', type: 'taskNode', position: { x: 5, y: 6 }, data: { assetCategory: 1, entityId: '4000', imageUrl: original } },
    ] })
    syncLensAssetTaskImage(target, image)
    const [child, parent] = useRFStore.getState().nodes
    expect(child.data).toMatchObject({ imageUrl: image, imageResults: [{ url: original }, { url: image }], imagePrimaryIndex: 1, prompt: '原提示词', anchorBindings: [{ entityId: '4258', imageUrl: image }] })
    expect(parent.data.imageUrl).toBe(original)
    expect(child.position).toEqual({ x: 1, y: 2 })
    syncLensAssetTaskImage(target, image)
    expect(useRFStore.getState().nodes[0].data.imageResults).toHaveLength(2)
    window.history.replaceState(null, '', '/canvas/?dramaId=999')
    syncLensAssetTaskImage(target, original)
    expect(useRFStore.getState().nodes[0].data.imageUrl).toBe(image)
  })
})
