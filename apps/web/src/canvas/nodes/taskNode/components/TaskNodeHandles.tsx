import React from 'react'
import { Handle, Position } from '@xyflow/react'
import { getHandleTypeLabel } from '../../../utils/handleLabels'
import { buildHandleStyle, getHandlePositionName, HANDLE_HORIZONTAL_OFFSET } from '../../taskNodeHelpers'
import { $t } from '../../../i18n'

type HandleDef = { id: string; type: string; pos: Position }

type TaskNodeHandlesProps = {
  targets: HandleDef[]
  sources: HandleDef[]
  layout: Map<string, { top?: string; left?: string }>
  defaultInputType: string
  defaultOutputType: string
  wideHandleBase: React.CSSProperties
  showHandles?: boolean
  showWideHandles?: boolean
}

export function TaskNodeHandles({
  targets,
  sources,
  layout,
  defaultInputType,
  defaultOutputType,
  wideHandleBase,
  showHandles = true,
  showWideHandles = true,
}: TaskNodeHandlesProps) {
  if (!showHandles) return null
  return (
    <div className="tc-handle-layer" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {targets.map((h) => {
        const handleLabel = getHandleTypeLabel(h.type)
        const handlePositionName = getHandlePositionName(h.pos)
        return (
          <Handle
            key={h.id}
            id={h.id}
            className="tc-handle"
            type="target"
            position={h.pos}
            style={buildHandleStyle(h, layout)}
            data-handle-type={h.type}
            data-handle-position={handlePositionName}
            title={$t('输入: {{v1}}', { v1: handleLabel })}
            aria-label={$t('输入: {{v1}}', { v1: handleLabel })}
          />
        )
      })}
      {sources.map((h) => {
        const handleLabel = getHandleTypeLabel(h.type)
        const handlePositionName = getHandlePositionName(h.pos)
        return (
          <Handle
            key={h.id}
            id={h.id}
            className="tc-handle"
            type="source"
            position={h.pos}
            style={buildHandleStyle(h, layout)}
            data-handle-type={h.type}
            data-handle-position={handlePositionName}
            title={$t('输出: {{v1}}', { v1: handleLabel })}
            aria-label={$t('输出: {{v1}}', { v1: handleLabel })}
          />
        )
      })}
      {showWideHandles && (
        <>
          <Handle
            id={`in-${defaultInputType}-wide`}
            className="tc-handle tc-handle--wide"
            type="target"
            position={Position.Left}
            style={{ ...wideHandleBase, left: -HANDLE_HORIZONTAL_OFFSET, transform: 'translate(-50%, -50%)' }}
            data-handle-type={defaultInputType}
            data-handle-position="left"
            title={$t('输入: {{v1}}', { v1: getHandleTypeLabel(defaultInputType) })}
            aria-label={$t('输入: {{v1}}', { v1: getHandleTypeLabel(defaultInputType) })}
          />
          <Handle
            id={`out-${defaultOutputType}-wide`}
            className="tc-handle tc-handle--wide"
            type="source"
            position={Position.Right}
            style={{ ...wideHandleBase, right: -HANDLE_HORIZONTAL_OFFSET, transform: 'translate(50%, -50%)' }}
            data-handle-type={defaultOutputType}
            data-handle-position="right"
            title={$t('输出: {{v1}}', { v1: getHandleTypeLabel(defaultOutputType) })}
            aria-label={$t('输出: {{v1}}', { v1: getHandleTypeLabel(defaultOutputType) })}
          />
        </>
      )}
    </div>
  )
}
