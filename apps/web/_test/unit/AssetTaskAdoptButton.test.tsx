import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { AssetTaskPanelCard } from '../../src/canvas/components/AssetTaskPanelCard'
const mocks = vi.hoisted(() => ({ associate: vi.fn(), sync: vi.fn() }))
vi.mock('../../src/api/lens', async (original) => ({ ...await original<typeof import('../../src/api/lens')>(), associateLensAssetTaskResult: mocks.associate }))
vi.mock('../../src/canvas/utils/lensAssetTaskAdoption', () => ({ syncLensAssetTaskImage: mocks.sync }))
const target = { category: 1, entityId: '4258', dramaId: '738', label: '子造型' }
const original = 'https://example.test/a.png', second = 'https://example.test/b.png'
beforeEach(() => {
  mocks.associate.mockResolvedValue(undefined)
  // jsdom 没有布局滚动实现，补齐下拉选中项使用的浏览器方法。
  HTMLElement.prototype.scrollIntoView = vi.fn()
})
afterEach(() => { cleanup(); vi.resetAllMocks() })
function renderCard(fileUrl = original) {
  return render(<MantineProvider><AssetTaskPanelCard target={target} canViewParams record={{ id: '1', taskStatus: 'SUCCESS', fileUrl, prompt: '测试提示词', reqPar: '{}' }} /></MantineProvider>)
}
describe('任务卡片采纳结果', () => {
  it('按钮顺序为采纳、复制、参数；取消确认不写入', async () => {
    const view = renderCard()
    const actions = view.container.querySelector('.lens-asset-task-panel__actions')
    expect(actions?.textContent).toBe('采纳结果复制提示词查看参数')
    fireEvent.click(screen.getByRole('button', { name: '采纳结果' }))
    expect(await screen.findByRole('img', { name: '待采纳图片' })).toHaveAttribute('src', original)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(mocks.associate).not.toHaveBeenCalled()
  })
  it('多图可切换，确认只关联选中的原图', async () => {
    renderCard(original + ',' + second)
    fireEvent.click(screen.getByRole('button', { name: '采纳结果' }))
    fireEvent.click(await screen.findByRole('textbox', { name: '选择采纳图片' }))
    fireEvent.click(await screen.findByRole('option', { name: '结果 2' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认采纳' }))
    await waitFor(() => expect(mocks.associate).toHaveBeenCalledWith(target, second))
    expect(mocks.sync).toHaveBeenCalledWith(target, second)
  })
  it('请求失败不改节点，确认弹窗保留原因并可重试', async () => {
    mocks.associate.mockRejectedValueOnce(new Error('资产不可编辑'))
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: '采纳结果' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认采纳' }))
    await screen.findByRole('alert')
    expect(screen.getByRole('alert')).toHaveTextContent('资产不可编辑')
    expect(mocks.sync).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: '确认采纳' }))
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(1))
  })
  it('无原图结果时采纳禁用', () => {
    renderCard('')
    expect(screen.getByRole('button', { name: '采纳结果' })).toBeDisabled()
  })
  it('请求期间重复点击只提交一次', async () => {
    let resolve: (() => void) | undefined
    mocks.associate.mockImplementation(() => new Promise<void>((done) => { resolve = done }))
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: '采纳结果' }))
    const confirm = await screen.findByRole('button', { name: '确认采纳' })
    fireEvent.click(confirm); fireEvent.click(confirm)
    expect(mocks.associate).toHaveBeenCalledTimes(1)
    resolve?.()
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(1))
  })
})
