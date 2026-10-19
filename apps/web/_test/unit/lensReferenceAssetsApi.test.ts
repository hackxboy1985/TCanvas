import { afterEach, describe, expect, it, vi } from 'vitest'
import { listReferenceAssets, type LensRole } from '../../src/api/lens'
import { groupReferenceAssets, ReferenceCategory } from '../../src/canvas/nodes/lensShotReferences'
afterEach(() => vi.unstubAllGlobals())
describe('参考资产真实接口契约', () => {
  it('主角色与全部子角色分别请求，合并后保留父子分组和字符串身份', async () => {
    const parentId = '9007199254740993'
    const childId = '9007199254740994'
    const fetch = vi.fn().mockImplementation(async (_url: string, options: RequestInit) => {
      const query = JSON.parse(String(options.body)) as { roleType?: number }
      return new Response(JSON.stringify({ code: 200, rows: query.roleType === 1
        ? [{ id: childId, parentId, roleType: 1, cloneName: '冬装', threeImg: '/winter.png' }]
        : [{ id: parentId, roleName: '主角', threeImg: '/main.png' }], total: 1 }))
    })
    vi.stubGlobal('fetch', fetch)
    const rows = await listReferenceAssets<LensRole>('720', ReferenceCategory.Role)
    expect(fetch.mock.calls.map((call) => [call[0], JSON.parse(String(call[1].body))])).toEqual([
      ['/api/lensRole/list', { dramaId: '720', allRole: 1 }],
      ['/api/lensRole/list', { dramaId: '720', roleType: 1 }],
    ])
    expect(groupReferenceAssets(ReferenceCategory.Role, rows)[0].items.map((item) => item.id)).toEqual([parentId, childId])
  })
  it('子角色查询失败时显式报错，不展示不完整主角色列表', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, options: RequestInit) => new Response(JSON.stringify(
      JSON.parse(String(options.body)).roleType === 1 ? { code: 500, msg: '子造型读取失败' } : { code: 200, rows: [], total: 0 }
    ))))
    await expect(listReferenceAssets('720', ReferenceCategory.Role)).rejects.toThrow('子造型读取失败')
  })
})
