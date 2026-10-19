import { afterEach, describe, expect, it, vi } from 'vitest'
import { listAssetImageTasks, LensAssetTaskStatus } from '../../src/api/lens'
import { loadLensAssetTaskApplicationIds } from '../../src/canvas/utils/lensAssetTaskApplications'

afterEach(() => vi.unstubAllGlobals())

describe('资产任务真实接口契约', () => {
  it('仅调用 /api/task/list，保留字符串资产ID与指定筛选参数', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 200, rows: [], total: 0 })))
    vi.stubGlobal('fetch', fetch)
    await listAssetImageTasks({ dramaId: '720', assetId: '3913', assetType: 0, applicationIds: ['47', '52'], pageNum: 1, pageSize: 20, taskStatus: LensAssetTaskStatus.All })
    expect(fetch.mock.calls[0][0]).toBe('/api/task/list')
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ pageNum: 1, pageSize: 20, keyword: '', taskStatus: '', taskStatusNot: 'FAILED', dramaId: '720', episodeNum: '', assetType: '0', assetId: '3913', applicationIds: ['47', '52'] })
  })
  it('选择失败状态时去掉失败排除条件，避免过滤自相矛盾', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 200, rows: [], total: 0 })))
    vi.stubGlobal('fetch', fetch)
    await listAssetImageTasks({ dramaId: '720', assetId: '3913', assetType: 0, applicationIds: ['47'], pageNum: 1, pageSize: 20, taskStatus: LensAssetTaskStatus.Failed })
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ taskStatus: 'FAILED', taskStatusNot: '' })
  })
  it('生图应用由模型接口动态加载，只保留启用项并去重', async () => {
    const fetch = vi.fn().mockImplementation(async (url: string) => new Response(JSON.stringify({ code: 200, data: url.endsWith('image2image') ? [{ value: '52', enabled: true }, { value: '47', enabled: true }] : [{ value: '47', enabled: true }, { value: '99', enabled: false }] })))
    vi.stubGlobal('fetch', fetch)
    expect(await loadLensAssetTaskApplicationIds()).toEqual(['47', '52'])
  })
})
