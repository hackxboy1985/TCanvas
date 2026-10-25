import type { MouseEvent as ReactMouseEvent } from 'react'
import type { ReactFlowInstance } from '@xyflow/react'
import { NODE_FOCUS_DURATION_MS, NODE_FOCUS_MIN_ZOOM, NODE_FOCUS_ZOOM } from './constants'

/** React Flow 每个节点渲染出的容器类名 */
const NODE_DOM_SELECTOR = '.react-flow__node'

/** 矩形（屏幕坐标或画布坐标，由调用方语义决定） */
export type FocusRect = { x: number; y: number; w: number; h: number }

/**
 * 读取双击命中的节点容器在屏幕上的真实矩形。
 *
 * <p><b>为什么必须读 DOM</b>：组内子节点（子造型/子场景）的 `position` 是相对父级组框的
 * 相对坐标，且 `measured` 尺寸可能滞后于媒体加载完成。只有真实 DOM 矩形能同时反映
 * 父级偏移、实际渲染尺寸与当前画布变换，用它换算出的中心点才不会偏。
 *
 * @param nodeId 目标节点 id
 * @param evt    触发双击的事件（可能为空：程序化调用场景）
 * @returns 屏幕矩形；事件命中的不是该节点容器时返回 null
 */
function readNodeDomRect(nodeId: string, evt?: ReactMouseEvent): FocusRect | null {
  const target = (evt?.target ?? null) as HTMLElement | null
  if (!target || typeof target.closest !== 'function') return null
  const el = target.closest(NODE_DOM_SELECTOR) as HTMLElement | null
  if (!el) return null
  // 冒泡链上可能出现多个节点容器，只认同 id 的那一个
  if (String(el.dataset.id ?? '') !== nodeId) return null
  const rect = el.getBoundingClientRect()
  if (!(rect.width > 0) || !(rect.height > 0)) return null
  return { x: rect.left, y: rect.top, w: rect.width, h: rect.height }
}

/**
 * 双击聚焦节点：把节点居中并把缩放固定到统一倍率（不低于 80%）。
 *
 * <p>所有生图/生视频节点（自由图片、图片编辑、lens 资产投影角色/子造型/场景/子场景/道具、
 * 分镜）共用本方法，保证双击行为完全一致。
 *
 * @param rf           React Flow 实例
 * @param nodeId       目标节点 id
 * @param evt          触发双击的事件（用于读取节点真实屏幕矩形）
 * @param fallbackRect 取不到 DOM 矩形时的兜底矩形（画布坐标）提供函数
 * @returns 是否已执行聚焦
 */
export function focusNodeInViewport(
  rf: ReactFlowInstance,
  nodeId: string,
  evt?: ReactMouseEvent,
  fallbackRect?: () => FocusRect | null,
): boolean {
  const domRect = readNodeDomRect(nodeId, evt)
  let center: { x: number; y: number } | null = null
  if (domRect) {
    // 屏幕坐标 → 画布坐标：内部已扣除画布容器的偏移与当前变换
    center = rf.screenToFlowPosition({ x: domRect.x + domRect.w / 2, y: domRect.y + domRect.h / 2 })
  } else {
    const fallback = fallbackRect?.() ?? null
    if (fallback && Number.isFinite(fallback.x) && Number.isFinite(fallback.y)) {
      center = { x: fallback.x + fallback.w / 2, y: fallback.y + fallback.h / 2 }
    }
  }
  if (!center || !Number.isFinite(center.x) || !Number.isFinite(center.y)) return false
  rf.setCenter(center.x, center.y, {
    zoom: Math.max(NODE_FOCUS_MIN_ZOOM, NODE_FOCUS_ZOOM),
    duration: NODE_FOCUS_DURATION_MS,
  })
  return true
}
