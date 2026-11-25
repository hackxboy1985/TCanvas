import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { LensEpisodeSelect } from '../../src/projects/LensEpisodeSelect'

afterEach(cleanup)

/** 使用真实 Mantine 选集控件，避免 mock 掩盖重复选择会反选的行为。 */
function renderSelect(episodeNum: number, episodeNumbers: number[]) {
  const onChange = vi.fn()
  render(
    <MantineProvider>
      <LensEpisodeSelect episodeNum={episodeNum} onChange={onChange}
        options={episodeNumbers.map((value) => ({ value: String(value), label: '第' + value + '集' }))} />
    </MantineProvider>,
  )
  return onChange
}

/** 每次都重新打开下拉，模拟用户反复选择当前集。 */
function chooseEpisode(episodeNum: number) {
  fireEvent.click(screen.getByRole('textbox'))
  fireEvent.click(screen.getByRole('option', { name: '第' + episodeNum + '集' }))
}

describe('画布选集', () => {
  it('只有一集时重复点选当前集，不触发切集（不会把 null 转成 0）', () => {
    const onChange = renderSelect(1, [1])
    chooseEpisode(1)
    chooseEpisode(1)
    chooseEpisode(1)
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox')).toHaveValue('第1集')
  })

  it('多集时再次选择当前集也不触发保存或加载', () => {
    const onChange = renderSelect(3, [1, 3, 8])
    chooseEpisode(3)
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox')).toHaveValue('第3集')
  })

  it('切换其他集传真实业务集号，不使用选项下标', () => {
    const onChange = renderSelect(3, [1, 3, 8])
    chooseEpisode(8)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(8)
  })
})
