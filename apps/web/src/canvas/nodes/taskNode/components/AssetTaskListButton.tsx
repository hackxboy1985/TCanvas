import React from 'react'
import { ActionIcon, Button, Tooltip } from '@mantine/core'
import { IconList } from '@tabler/icons-react'
import { useCanvasRenderContext } from '../../../CanvasRenderContext'
import { readLensAssetTaskIdentity } from '../../../utils/lensAssetTaskIdentity'

/** 仅业务资产显示任务入口；没有生成结果时也能查看排队、失败及历史任务。 */
export function AssetTaskListButton({ nodeId, data, showLabel = false }: { nodeId: string; data: Record<string, unknown>; showLabel?: boolean }) {
  const { onOpenTaskResult } = useCanvasRenderContext()
  if (!onOpenTaskResult || !readLensAssetTaskIdentity(data)) return null
  // 工具栏入口带文字，节点标题入口保持紧凑图标；两者共用同一回调。
  if (showLabel) return (
    <div className="lens-asset-task-toolbar-actions">
      <Button className="lens-asset-task-results nodrag nopan" size="compact-xs" variant="subtle" color="gray"
        leftSection={<IconList className="lens-asset-task-results-icon" size={14} />}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => { event.stopPropagation(); onOpenTaskResult(nodeId) }}>任务结果</Button>
    </div>
  )
  return (
    <Tooltip className="lens-asset-task-tooltip" label="任务记录" withArrow>
      <ActionIcon className="lens-asset-task-button nodrag nopan" variant="subtle" color="gray" size="sm"
        aria-label="任务记录" onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => { event.stopPropagation(); onOpenTaskResult(nodeId) }}>
        <IconList className="lens-asset-task-button-icon" size={16} />
      </ActionIcon>
    </Tooltip>
  )
}
