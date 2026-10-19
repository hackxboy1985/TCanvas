import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { TaskResultDrawer, type TaskResultTarget } from '../../src/canvas/components/TaskResultDrawer'
import type { LensTaskPage } from '../../src/api/lens'

const api = vi.hoisted(() => ({ listAssetImageTasks: vi.fn(), listShotVideoTasks: vi.fn(), adoptShotResult: vi.fn() }))
vi.mock('../../src/api/lens', async (importOriginal) => ({ ...await importOriginal<typeof import('../../src/api/lens')>(), ...api }))
vi.mock('../../src/canvas/utils/lensAssetTaskApplications', () => ({ loadLensAssetTaskApplicationIds: async () => ['47', '52'] }))

/** 用真实抽屉组件验证查询，网络层只返回明确的测试记录。 */
function drawer(target: TaskResultTarget, opened = true) {
  return <MantineProvider><TaskResultDrawer opened={opened} target={target} onClose={() => {}} /></MantineProvider>
}

afterEach(() => { cleanup(); vi.resetAllMocks() })

describe('资产生图任务列表', () => {
  it.each([['role', 0], ['scene', 1], ['prop', 2]] as const)('按 %s 自身资产ID查询', async (kind, assetType) => {
    api.listAssetImageTasks.mockResolvedValue({ rows: [], total: 0 })
    render(drawer({ nodeId: 'child', title: '子资产', kind, entityId: '9223372036854775806', dramaId: '100' }))
    await waitFor(() => expect(api.listAssetImageTasks).toHaveBeenCalledWith({ dramaId: '100', assetType, assetId: '9223372036854775806', pageNum: 1, pageSize: 20, applicationIds: ['47', '52'], taskStatus: '' }))
    expect(api.listShotVideoTasks).not.toHaveBeenCalled()
  })
  it('无资产ID时显式报错且不查询全量任务', async () => {
    render(drawer({ nodeId: 'missing', title: '无ID', kind: 'role', dramaId: '100' }))
    await screen.findByText('资产节点缺少实体ID，无法查询任务')
    expect(api.listAssetImageTasks).not.toHaveBeenCalled()
  })
  it('切换资产后忽略上一个资产的慢响应', async () => {
    let finishPrevious!: (page: LensTaskPage) => void
    api.listAssetImageTasks.mockImplementationOnce(() => new Promise<LensTaskPage>((resolve) => { finishPrevious = resolve }))
      .mockResolvedValue({ rows: [{ id: '2', prompt: '当前子场景任务', taskStatus: 'SUCCESS' }], total: 1 })
    const initial: TaskResultTarget = { nodeId: 'parent', title: '主场景', kind: 'scene', entityId: '123', dramaId: '100' }
    const view = render(drawer(initial))
    await waitFor(() => expect(api.listAssetImageTasks).toHaveBeenCalledTimes(1))
    view.rerender(drawer({ ...initial, nodeId: 'child', title: '子场景', entityId: '124' }))
    await screen.findByText('当前子场景任务')
    await act(async () => finishPrevious({ rows: [{ id: '1', prompt: '过期主场景任务', taskStatus: 'SUCCESS' }], total: 1 }))
    expect(screen.queryByText('过期主场景任务')).toBeNull()
    expect(screen.getByText('当前子场景任务')).toBeInTheDocument()
  })
  it('关闭时不发起请求', () => {
    render(drawer({ nodeId: 'closed', title: '角色', kind: 'role', entityId: '123', dramaId: '100' }, false))
    expect(api.listAssetImageTasks).not.toHaveBeenCalled()
  })
})
