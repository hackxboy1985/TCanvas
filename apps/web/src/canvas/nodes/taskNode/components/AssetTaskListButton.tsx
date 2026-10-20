import React from 'react'
import { ActionIcon, Button, Tooltip } from '@mantine/core'
import { IconList } from '@tabler/icons-react'
import { useCanvasRenderContext } from '../../../CanvasRenderContext'
import { readLensAssetTaskIdentity } from '../../../utils/lensAssetTaskIdentity'
import { getLensCanvasFlowId, readCanvasNodeAssetId } from '../../../utils/canvasNodeAssetId'

/**
 * 任务入口按钮：业务资产节点与画布自由节点（含衍生出的图片编辑/角度/打光节点）都要显示。
 *
 * <p>自由节点的任务归属是 sceneId(画布flowId)+assetType=10+assetId(节点数字ID)，
 * 与业务资产口径不同，但都有历史任务可查；只显示业务资产会让衍生节点永远没有任务入口。
 */
export function AssetTaskListButton({ nodeId, data, showLabel = false, onOpen }: { nodeId: string; data: Record<string, unknown>; showLabel?: boolean; onOpen?: (nodeId: string) => void }) {
  const { onOpenTaskResult: openDrawer } = useCanvasRenderContext()
  // 生图工具栏使用就地列表；未指定时保留原入口能力，不改原固定抽屉。
  const onOpenTaskResult = onOpen || openDrawer
  // 业务资产（角色/场景/道具）走实体ID；自由节点（含图片编辑衍生节点）走画布节点归属。
  // 这里只看「有没有 canvasNodeAssetId」，不再依赖 flowId：flowId 在编排加载后才注入，
  // 若把它作为显示条件，节点首帧渲染时按钮会消失（表现为衍生节点没有任务入口）。
  const hasAssetIdentity = Boolean(readLensAssetTaskIdentity(data))
  const hasCanvasNodeIdentity = readCanvasNodeAssetId(data) !== null
  if (!onOpenTaskResult || (!hasAssetIdentity && !hasCanvasNodeIdentity)) return null
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
