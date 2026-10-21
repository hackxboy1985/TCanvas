import React from 'react'
import { ActionIcon, Text, Tooltip } from '@mantine/core'
import { IconGripVertical, IconPlus, IconX } from '@tabler/icons-react'
import type { OrderedUpstreamReferenceItem } from '../upstreamReferences'
import { ManagedImage } from '../../../../domain/resource-runtime'
import { useUIStore } from '../../../../ui/uiStore'

type UpstreamReferenceStripProps = {
  targetNodeId: string
  items: OrderedUpstreamReferenceItem[]
  onRemove: (edgeId: string) => void
  onReorder: (draggedEdgeId: string, targetEdgeId: string) => void
  onToggleCanvasReferencePicker: () => void
  canvasReferencePickerActive: boolean
  /**
   * 节点本地的局部编辑引导图（`node.data.poseMaskUrl`）。
   *
   * <p><b>只读项</b>：它不来自连线，不参与参考顺序、不能拖拽/删除，
   * 仅用于让用户确认「本次局部编辑确实带了引导图」；点击走站内大图预览。
   */
  maskGuideUrl?: string | null
  /** 本地引导图的展示名（默认「局部编辑引导图」） */
  maskGuideLabel?: string
}

export function UpstreamReferenceStrip({
  targetNodeId,
  items,
  onRemove,
  onReorder,
  onToggleCanvasReferencePicker,
  canvasReferencePickerActive,
  maskGuideUrl,
  maskGuideLabel = '局部编辑引导图',
}: UpstreamReferenceStripProps) {
  const [draggedEdgeId, setDraggedEdgeId] = React.useState<string | null>(null)
  const normalizedMaskGuideUrl = typeof maskGuideUrl === 'string' ? maskGuideUrl.trim() : ''

  return (
    <div className="tc-task-node__upstream-reference-strip">
      <div className="tc-task-node__upstream-reference-strip-header">
        <Text className="tc-task-node__upstream-reference-strip-title" size="xs" fw={600}>
          上游参考
        </Text>
        <Text className="tc-task-node__upstream-reference-strip-meta" size="xs" c="dimmed">
          {canvasReferencePickerActive ? '点击画布图片直接连接' : '拖动调整顺序'}
        </Text>
      </div>
      <div className="tc-task-node__upstream-reference-strip-list">
        {items.map((item, index) => (
          <Tooltip key={`${item.edgeId}-${item.previewUrl}`} label={item.label} withArrow openDelay={180}>
            <div
              className={[
                'tc-task-node__upstream-reference-card',
                draggedEdgeId === item.edgeId ? 'tc-task-node__upstream-reference-card--dragging' : '',
              ].join(' ')}
              title={item.label}
              draggable
              onDragStart={(event) => {
                setDraggedEdgeId(item.edgeId)
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', item.edgeId)
              }}
              onDragEnd={() => {
                setDraggedEdgeId(null)
              }}
              onDragOver={(event) => {
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
              }}
              onDrop={(event) => {
                event.preventDefault()
                const sourceEdgeId = event.dataTransfer.getData('text/plain') || draggedEdgeId
                setDraggedEdgeId(null)
                if (!sourceEdgeId || sourceEdgeId === item.edgeId) return
                onReorder(sourceEdgeId, item.edgeId)
              }}
            >
              <ManagedImage
                className="tc-task-node__upstream-reference-image"
                src={item.previewUrl}
                alt={item.label}
                kind="preview"
                variantKey="preview"
                priority="prefetch"
                ownerNodeId={targetNodeId}
                ownerSurface="task-node-upstream-reference"
                ownerRequestKey={`task-node-upstream-reference:${targetNodeId}:${item.edgeId}`}
                loading="lazy"
                decoding="async"
                fetchPriority="low"
                referrerPolicy="no-referrer"
              />
              <span className="tc-task-node__upstream-reference-drag-handle" aria-hidden="true">
                <IconGripVertical size={10} stroke={1.8} />
              </span>
              <span className="tc-task-node__upstream-reference-order">
                {index + 1}
              </span>
              <ActionIcon
                className="tc-task-node__upstream-reference-remove"
                size="xs"
                variant="filled"
                color="dark"
                aria-label={`删除 ${item.label} 引用及连线`}
                onPointerDown={(event) => event.stopPropagation()}
                onDragStart={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  onRemove(item.edgeId)
                }}
              >
                <IconX size={10} stroke={2.3} />
              </ActionIcon>
            </div>
          </Tooltip>
        ))}
        {normalizedMaskGuideUrl ? (
          <Tooltip label={`${maskGuideLabel}（只读，点击预览）`} withArrow openDelay={180}>
            <button
              type="button"
              className="tc-task-node__upstream-reference-card tc-task-node__upstream-reference-card--mask-guide"
              aria-label={`预览${maskGuideLabel}`}
              onClick={(event) => {
                // 只做预览：该图不是连线引用，不能拖拽排序，也不能删除
                event.preventDefault()
                event.stopPropagation()
                useUIStore.getState().openPreview({ url: normalizedMaskGuideUrl, kind: 'image', name: maskGuideLabel })
              }}
            >
              <ManagedImage
                className="tc-task-node__upstream-reference-image"
                src={normalizedMaskGuideUrl}
                alt={maskGuideLabel}
                kind="preview"
                variantKey="preview"
                priority="prefetch"
                ownerNodeId={targetNodeId}
                ownerSurface="task-node-upstream-reference"
                ownerRequestKey={`task-node-mask-guide:${targetNodeId}`}
                loading="lazy"
                decoding="async"
                fetchPriority="low"
                referrerPolicy="no-referrer"
              />
              <span className="tc-task-node__upstream-reference-mask-tag">圈选</span>
            </button>
          </Tooltip>
        ) : null}
        <Tooltip
          label={canvasReferencePickerActive ? '退出从画布选择参考' : '从画布选择参考'}
          withArrow
          openDelay={180}
        >
          <button
            className={[
              'tc-task-node__upstream-reference-add',
              canvasReferencePickerActive ? 'tc-task-node__upstream-reference-add--active' : '',
            ].join(' ')}
            type="button"
            aria-label={canvasReferencePickerActive ? '退出从画布选择参考' : '从画布选择参考'}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              onToggleCanvasReferencePicker()
            }}
          >
            <IconPlus size={14} stroke={2} />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}
