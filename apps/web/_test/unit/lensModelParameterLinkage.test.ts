import { describe, expect, it } from 'vitest'
import { toLensModelOptions, readLensModelQualities } from '../../src/config/useModelOptions'
import { parseImageModelCatalogConfig } from '../../src/config/modelCatalogMeta'
import { resolveModelGenerationCredits } from '../../src/config/modelPricing'

/** 模型切换必须使用各自配置，不补造通用比例、分辨率或质量。 */
describe('Lens 生图参数随模型联动', () => {
  it('不同模型分别解析各自比例、分辨率、质量', () => {
    const models = toLensModelOptions([
      { value: '101', resolutions: ['1K', '2K'], others: { supportedRatios: ['3:2', '2:3'], qualities: ['high'] } },
      { value: '102', resolutions: ['4K'], others: { supportedRatios: ['21:9'], qualities: ['medium', 'max'] } },
    ])
    const first = parseImageModelCatalogConfig(models[0].meta)
    const second = parseImageModelCatalogConfig(models[1].meta)
    expect(first?.aspectRatioOptions.map((o) => o.value)).toEqual(['3:2', '2:3'])
    expect(second?.aspectRatioOptions.map((o) => o.value)).toEqual(['21:9'])
    expect(first?.resolutionOptions.map((o) => o.value)).toEqual(['1K', '2K'])
    expect(second?.resolutionOptions.map((o) => o.value)).toEqual(['4K'])
    expect(first?.controls.some((c) => c.binding === 'resolution')).toBe(true)
    expect(readLensModelQualities(models[0].meta)).toEqual(['high'])
    expect(readLensModelQualities(models[1].meta)).toEqual(['medium', 'max'])
  })
  it('积分随模型与分辨率联动，未配置分辨率价格时沿用模型基础价', () => {
    const [a, b] = toLensModelOptions([
      { value: '104', unitConsume: 8, resolutionPrices: { '2k': 15, '4K': 30 } },
      { value: '105', unitConsume: 20 },
    ])
    const price = (modelOption: typeof a, resolution: string, quantity = 1) => resolveModelGenerationCredits({ kind: 'image', modelOption, specValues: { resolution }, quantity })
    expect(price(a, '2K')).toBe(15)
    expect(price(a, '4K', 2)).toBe(60)
    expect(price(a, '1K')).toBe(8)
    expect(price(b, '2K')).toBe(20)
    expect(toLensModelOptions([{ value: '106' }])[0].pricing).toBeUndefined()
  })
  it('视频积分随分辨率、时长和模型切换，使用后端解析的单价', () => {
    const [a, b] = toLensModelOptions([
      { value: '201', unitConsume: 10, creditPricing: { perSecond: true, cost: 10, resolutionPrices: { '480p': 5, '720p': 10, '1080p': 23 } } },
      { value: '202', unitConsume: 7, creditPricing: { perSecond: true, cost: 7, resolutionPrices: { '1080p': 14 } } },
    ])
    const price = (modelOption: typeof a, resolution: string, durationSeconds: number) => resolveModelGenerationCredits({ kind: 'video', modelOption, specKey: `${resolution}:${durationSeconds}`, specValues: { resolution }, durationSeconds })
    expect(price(a, '480p', 5)).toBe(25)
    expect(price(a, '720p', 5)).toBe(50)
    expect(price(a, '1080P', 5)).toBe(115)
    expect(price(a, '1080p', 10)).toBe(230)
    expect(price(b, '1080p', 5)).toBe(70)
    expect(price(a, '720p', 0)).toBeNull()
  })
  it('视频一次性计费不乘时长，缺报价不伪造积分', () => {
    const [once, missing] = toLensModelOptions([
      { value: '203', unitConsume: 8, creditPricing: { perSecond: false, cost: 8, resolutionPrices: { '1080p': 18 } } },
      { value: '204', unitConsume: 8 },
    ])
    expect(resolveModelGenerationCredits({ kind: 'video', modelOption: once, specValues: { resolution: '1080p' }, durationSeconds: 10 })).toBe(18)
    expect(resolveModelGenerationCredits({ kind: 'video', modelOption: missing, durationSeconds: 10 })).toBeNull()
  })
  it('未配置模型参数时不提供硬编码选项', () => {
    const [model] = toLensModelOptions([{ value: '103' }])
    const config = parseImageModelCatalogConfig(model.meta)
    expect(config?.aspectRatioOptions ?? []).toEqual([])
    expect(config?.resolutionOptions ?? []).toEqual([])
    expect(readLensModelQualities(model.meta)).toEqual([])
  })
})
