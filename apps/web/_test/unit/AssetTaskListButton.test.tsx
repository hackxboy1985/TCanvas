import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { CanvasRenderContext } from '../../src/canvas/CanvasRenderContext'
import { AssetTaskListButton } from '../../src/canvas/nodes/taskNode/components/AssetTaskListButton'

describe('资产任务列表入口', () => {
  it('无结果的子造型仍显示入口并传递本节点ID', () => {
    const onOpenTaskResult = vi.fn()
    render(<MantineProvider><CanvasRenderContext.Provider value={{ heavySelectionActive: false, heavySelectionDragging: false, selectedNodeCount: 0, onOpenTaskResult }}>
      <AssetTaskListButton nodeId="role-child" data={{ assetCategory: 1, entityId: '123', parentEntityId: '12' }} />
    </CanvasRenderContext.Provider></MantineProvider>)
    fireEvent.click(screen.getByRole('button', { name: '任务记录' }))
    expect(onOpenTaskResult).toHaveBeenCalledWith('role-child')
    cleanup()
  })
  it('节点与底部工具栏入口打开相同资产列表', () => {
    const onOpenTaskResult = vi.fn()
    render(<MantineProvider><CanvasRenderContext.Provider value={{ heavySelectionActive: false, heavySelectionDragging: false, selectedNodeCount: 0, onOpenTaskResult }}>
      <AssetTaskListButton nodeId="scene-child" data={{ assetCategory: 2, entityId: '124' }} />
      <AssetTaskListButton nodeId="scene-child" data={{ assetCategory: 2, entityId: '124' }} showLabel />
    </CanvasRenderContext.Provider></MantineProvider>)
    fireEvent.click(screen.getByRole('button', { name: '任务记录' }))
    fireEvent.click(screen.getByRole('button', { name: '任务结果' }))
    expect(onOpenTaskResult.mock.calls).toEqual([['scene-child'], ['scene-child']])
    cleanup()
  })
  it('自由生图节点不显示入口', () => {
    render(<MantineProvider><CanvasRenderContext.Provider value={{ heavySelectionActive: false, heavySelectionDragging: false, selectedNodeCount: 0, onOpenTaskResult: vi.fn() }}>
      <AssetTaskListButton nodeId="free" data={{ canvasNodeAssetId: 123 }} />
    </CanvasRenderContext.Provider></MantineProvider>)
    expect(screen.queryByRole('button', { name: '任务记录' })).toBeNull()
    cleanup()
  })
})
