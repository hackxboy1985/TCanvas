import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ASPECT_OPTIONS,
  DEFAULT_MAX_DURATION,
  DEFAULT_MIN_DURATION,
  DEFAULT_RESOLUTION_OPTIONS,
  buildDurationOptions,
  clampDuration,
  convergeToOptions,
  resolveModelAspectOptions,
  resolveModelDurationRange,
  resolveModelResolutionOptions,
} from '../../src/canvas/utils/lensShotModelParams'

describe('lensShotModelParams · 时长区间', () => {
  it('读取模型 others.minDuration / maxDuration', () => {
    const range = resolveModelDurationRange({ others: { minDuration: 4, maxDuration: 12 } })
    expect(range).toEqual({ min: 4, max: 12 })
  })

  it('模型未配置时回退到默认 4~15', () => {
    expect(resolveModelDurationRange(undefined)).toEqual({ min: DEFAULT_MIN_DURATION, max: DEFAULT_MAX_DURATION })
    expect(resolveModelDurationRange({ others: {} })).toEqual({ min: DEFAULT_MIN_DURATION, max: DEFAULT_MAX_DURATION })
  })

  it('脏配置（min > max）整体回退到默认区间，不产出空选项', () => {
    const range = resolveModelDurationRange({ others: { minDuration: 20, maxDuration: 5 } })
    expect(range).toEqual({ min: DEFAULT_MIN_DURATION, max: DEFAULT_MAX_DURATION })
    expect(buildDurationOptions(range.min, range.max).length).toBeGreaterThan(0)
  })

  it('非数字 / 非正数配置按未配置处理', () => {
    expect(resolveModelDurationRange({ others: { minDuration: '4', maxDuration: 0 } })).toEqual({
      min: DEFAULT_MIN_DURATION,
      max: DEFAULT_MAX_DURATION,
    })
  })

  it('选项按秒展开且格式为 "Ns"', () => {
    expect(buildDurationOptions(4, 6)).toEqual([
      { value: '4', label: '4s' },
      { value: '5', label: '5s' },
      { value: '6', label: '6s' },
    ])
  })
})

describe('lensShotModelParams · 画幅联动', () => {
  it('模型配置 supportedRatios 时按配置下发', () => {
    expect(resolveModelAspectOptions({ others: { supportedRatios: ['16:9', '9:16', '1:1'] } })).toEqual([
      '16:9',
      '9:16',
      '1:1',
    ])
  })

  it('模型未配置时回退到通用画幅，保证下拉可用', () => {
    expect(resolveModelAspectOptions({ others: {} })).toEqual(DEFAULT_ASPECT_OPTIONS)
    expect(resolveModelAspectOptions(undefined)).toEqual(DEFAULT_ASPECT_OPTIONS)
  })

  it('过滤空白项与非字符串项，并去重', () => {
    expect(resolveModelAspectOptions({ others: { supportedRatios: ['16:9', ' 16:9 ', '', '  ', 42, '9:16'] } })).toEqual([
      '16:9',
      '9:16',
    ])
  })

  it('全部为非法项时回退到默认画幅', () => {
    expect(resolveModelAspectOptions({ others: { supportedRatios: ['', 42] } })).toEqual(DEFAULT_ASPECT_OPTIONS)
  })
})

describe('lensShotModelParams · 分辨率联动', () => {
  it('读取 meta.imageOptions.resolutionOptions（源自模型 resolutions）', () => {
    expect(
      resolveModelResolutionOptions({ imageOptions: { resolutionOptions: ['720p', '1080p', '2K', '4k'] } }),
    ).toEqual(['720p', '1080p', '2K', '4k'])
  })

  it('模型未配置时回退到通用分辨率', () => {
    expect(resolveModelResolutionOptions({ imageOptions: {} })).toEqual(DEFAULT_RESOLUTION_OPTIONS)
    expect(resolveModelResolutionOptions({})).toEqual(DEFAULT_RESOLUTION_OPTIONS)
  })
})

describe('lensShotModelParams · 值收敛', () => {
  it('当前值在候选内时保持不变（不打断用户已选）', () => {
    expect(convergeToOptions('9:16', ['16:9', '9:16'])).toBe('9:16')
  })

  it('当前值越界时收敛到候选第一项', () => {
    expect(convergeToOptions('4:3', ['16:9', '9:16'])).toBe('16:9')
    expect(convergeToOptions(null, ['16:9', '9:16'])).toBe('16:9')
  })

  it('候选为空时返回 null，由调用方显式处理', () => {
    expect(convergeToOptions('16:9', [])).toBeNull()
  })

  it('时长超界夹到边界，null 保持 null', () => {
    expect(clampDuration(3, 4, 15)).toBe(4)
    expect(clampDuration(20, 4, 15)).toBe(15)
    expect(clampDuration(8, 4, 15)).toBe(8)
    expect(clampDuration(null, 4, 15)).toBeNull()
  })
})
