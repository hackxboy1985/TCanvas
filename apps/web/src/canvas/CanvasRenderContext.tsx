import React from 'react'

export type CanvasRenderContextValue = {
  heavySelectionActive: boolean
  heavySelectionDragging: boolean
  selectedNodeCount: number
  /**
   * 打开「任务结果」抽屉（只读展示该节点的历史生成结果）。
   *
   * <p>由 LensCanvasApp 注入：抽屉需在画布顶层渲染，节点内部只负责触发。
   * 非 lens 宿主（未注入）时为 undefined，节点上的入口按钮不显示。
   */
  onOpenTaskResult?: (nodeId: string) => void
}

const DEFAULT_CANVAS_RENDER_CONTEXT: CanvasRenderContextValue = {
  heavySelectionActive: false,
  heavySelectionDragging: false,
  selectedNodeCount: 0,
}

export const CanvasRenderContext = React.createContext<CanvasRenderContextValue>(
  DEFAULT_CANVAS_RENDER_CONTEXT,
)

export function useCanvasRenderContext(): CanvasRenderContextValue {
  return React.useContext(CanvasRenderContext)
}
