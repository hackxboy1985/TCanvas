/**
 * 节点预设接口契约回归测试。
 *
 * <p>背景：后端 `NodePresetController` 按画布契约直接返回裸业务体
 * （GET 返回数组、POST 返回单个对象），**不含 RuoYi AjaxResult 的 `code` 字段**。
 * 前端曾用按 AjaxResult 校验的 lensFetch 解包，导致数组的 `code` 为 `undefined`、
 * `undefined !== 200` 成立而抛出「lens 接口失败」，画布顶部出现红色错误条。
 *
 * <p>本测试锁定该契约：裸数组/裸对象必须解析成功；
 * 而 AjaxResult 形态的业务错误仍必须显式失败（不得被静默当成裸业务体放行）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLensNodePreset, listLensNodePresets } from '../../src/api/lens'

/** 构造一个带 json/text 的 mock Response */
function mockResponse(body: unknown, init?: { status?: number; rawText?: string }): Response {
  const rawText = init?.rawText ?? JSON.stringify(body)
  return {
    status: init?.status ?? 200,
    ok: (init?.status ?? 200) >= 200 && (init?.status ?? 200) < 300,
    text: async () => rawText,
    json: async () => JSON.parse(rawText),
  } as unknown as Response
}

/** 一条字段齐备的节点预设（normalizeLensNodePreset 要求 id/title/prompt/type/scope） */
const VALID_PRESET = {
  id: '12',
  title: '写实电影光',
  type: 'text',
  prompt: 'cinematic lighting',
  scope: 'base',
  createdAt: '2026-10-10 10:00:00',
  updatedAt: '2026-10-10 10:00:00',
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('lens 节点预设接口契约', () => {
  it('GET 返回空数组时必须解析成功（不再抛「lens 接口失败」）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse([]))

    await expect(listLensNodePresets({ type: 'text' })).resolves.toEqual([])
  })

  it('GET 返回裸数组条目时必须解析成功', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse([VALID_PRESET]))

    const result = await listLensNodePresets({ type: 'text' })

    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('12')
    expect(result[0]?.type).toBe('text')
  })

  it('POST 返回裸对象时必须解析成功', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(VALID_PRESET))

    const created = await createLensNodePreset({
      title: '写实电影光',
      type: 'text',
      prompt: 'cinematic lighting',
    })

    expect(created.id).toBe('12')
  })

  it('AjaxResult 形态的业务错误仍必须显式失败（禁止静默放行）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      mockResponse({ code: 401, msg: '认证失败，无法访问系统资源' }),
    )

    await expect(listLensNodePresets({ type: 'text' })).rejects.toThrow(/认证失败/)
  })

  it('业务码非 200 且无 msg 时错误信息必须带 URL 与 code（可诊断）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse({ code: 500 }))

    await expect(listLensNodePresets({ type: 'text' })).rejects.toThrow(
      /code=500.*url=\/api\/ai\/node-presets/s,
    )
  })

  it('响应非 JSON 时必须显式失败并带上 URL', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      mockResponse(null, { rawText: '<html>login page</html>' }),
    )

    await expect(listLensNodePresets({ type: 'text' })).rejects.toThrow(/非 JSON/)
  })

  it('网络层失败时必须显式失败（CORS/连接被拒无状态码）', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Failed to fetch'))

    await expect(listLensNodePresets({ type: 'text' })).rejects.toThrow(/Failed to fetch/)
  })
})
