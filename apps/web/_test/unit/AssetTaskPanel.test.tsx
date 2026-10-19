import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { AssetTaskPanel } from '../../src/canvas/components/AssetTaskPanel'
import { AssetTaskListButton } from '../../src/canvas/nodes/taskNode/components/AssetTaskListButton'
import { CanvasRenderContext } from '../../src/canvas/CanvasRenderContext'
import { LensAssetTaskStatus, type LensTaskPage } from '../../src/api/lens'

const mocks = vi.hoisted(() => ({ list: vi.fn(), apps: vi.fn(), permission: vi.fn() }))
vi.mock('../../src/api/lens', async (original) => ({ ...await original<typeof import('../../src/api/lens')>(), listAssetImageTasks: mocks.list, canViewTaskParams: mocks.permission }))
vi.mock('../../src/canvas/utils/lensAssetTaskApplications', () => ({ loadLensAssetTaskApplicationIds: mocks.apps }))
const data = { assetCategory: 1, entityId: '3914', parentEntityId: '3913' }
const wrap = (child: React.ReactNode) => <MantineProvider>{child}</MantineProvider>
beforeEach(() => {
  window.history.replaceState(null, '', '/canvas/?dramaId=720')
  mocks.apps.mockResolvedValue(['47'])
  mocks.permission.mockResolvedValue(false)
  mocks.list.mockResolvedValue({ rows: [{ id: '1', taskStatus: 'SUCCESS', prompt: '当前资产任务', createUserName: '测试用户' }], total: 1 })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks() })
describe('工具栏右侧资产任务列表', () => {
  it('本地入口不触发原右侧抽屉', () => {
    const drawer = vi.fn(), local = vi.fn()
    render(wrap(<CanvasRenderContext.Provider value={{ heavySelectionActive: false, heavySelectionDragging: false, selectedNodeCount: 1, onOpenTaskResult: drawer }}>
      <AssetTaskListButton nodeId="child" data={data} showLabel onOpen={local} />
    </CanvasRenderContext.Provider>))
    fireEvent.click(screen.getByRole('button', { name: '任务结果' }))
    expect(local).toHaveBeenCalledWith('child')
    expect(drawer).not.toHaveBeenCalled()
  })
  it('查询子资产自身ID且不创建抽屉遮罩，左上角关闭只调用关闭回调', async () => {
    const close = vi.fn()
    render(wrap(<AssetTaskPanel data={data} onClose={close} />))
    await screen.findByText('当前资产任务')
    expect(mocks.list).toHaveBeenCalledWith({ dramaId: '720', assetId: '3914', assetType: 0, applicationIds: ['47'], taskStatus: LensAssetTaskStatus.All, pageNum: 1, pageSize: 20 })
    expect(document.querySelector('.mantine-Drawer-root')).toBeNull()
    expect(screen.queryByRole('button', { name: '查看参数' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '关闭任务列表' }))
    expect(close).toHaveBeenCalledTimes(1)
  })
  it('错误可见且可手动重试', async () => {
    mocks.list.mockRejectedValueOnce(new Error('接口拒绝访问'))
    render(wrap(<AssetTaskPanel data={data} onClose={vi.fn()} />))
    await screen.findByText('接口拒绝访问')
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    await screen.findByText('当前资产任务')
  })
  it('切换资产时废弃上一个资产的慢响应', async () => {
    let resolveOld: ((page: LensTaskPage) => void) | undefined
    mocks.list.mockImplementationOnce(() => new Promise<LensTaskPage>((resolve) => { resolveOld = resolve }))
    const view = render(wrap(<AssetTaskPanel data={data} onClose={vi.fn()} />))
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1))
    view.rerender(wrap(<AssetTaskPanel data={{ assetCategory: 2, entityId: '502' }} onClose={vi.fn()} />))
    await screen.findByText('当前资产任务')
    resolveOld?.({ rows: [{ id: 'old', prompt: '旧资产任务' }], total: 1 })
    await waitFor(() => expect(screen.queryByText('旧资产任务')).toBeNull())
    expect(mocks.list.mock.calls.at(-1)?.[0]).toMatchObject({ assetId: '502', assetType: 1 })
  })
  it('卸载后不再轮询未完成任务', async () => {
    mocks.list.mockResolvedValue({ rows: [{ id: '3', taskStatus: 'RUNNING', prompt: '等待生成的任务' }], total: 1 })
    const view = render(wrap(<AssetTaskPanel data={data} onClose={vi.fn()} />))
    await screen.findByText('等待生成的任务')
    vi.useFakeTimers()
    view.unmount()
    await vi.advanceTimersByTimeAsync(6000)
    expect(mocks.list).toHaveBeenCalledTimes(1)
  })
  it('显示多图结果和后端授权的参数入口', async () => {
    mocks.permission.mockResolvedValue(true)
    mocks.list.mockResolvedValue({ rows: [{ id: '2', taskStatus: 'SUCCESS', fileUrl: 'https://example.test/a.png,https://example.test/b.png', reqPar: '[{"aspectRatio":"16:9","images":["https://example.test/ref.png"]}]' }], total: 1 })
    render(wrap(<AssetTaskPanel data={data} onClose={vi.fn()} />))
    await screen.findByRole('button', { name: '预览结果 2' })
    expect(screen.getByRole('img', { name: '参考图 1' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '查看参数' })).toBeTruthy()
  })
})
