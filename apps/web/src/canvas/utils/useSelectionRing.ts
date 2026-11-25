import { useStore } from '@xyflow/react'

/** 节点选中态描边与柔光样式 */
export type SelectionRingStyle = {
  /** 描边（已按画布缩放反补） */
  border: string
  /** 外圈 + 柔光 + 投影（已按画布缩放反补） */
  boxShadow: string
}

/**
 * 节点通用选中态：描边 + 柔光。
 *
 * <p>画布缩放会给节点整体套 transform:scale，1px 描边缩到 35% 时不足 1 个设备像素直接消失。
 * 这里把描边宽度、外圈扩散、柔光半径全部按 1/zoom 反补，保证任何缩放级别下视觉粗细恒定，
 * 用户缩小画布后依然能快速定位当前选中的节点。</p>
 *
 * <p>只在选中时返回样式；未选中返回 null，调用方保持节点原有外观，不干扰其它节点。</p>
 *
 * @param selected 节点是否选中
 * @param isDark 当前是否暗色主题
 * @returns 选中态样式，未选中为 null
 */
export function useSelectionRing(selected: boolean, isDark: boolean): SelectionRingStyle | null {
  // 量化到 0.05：避免滚轮缩放时所有节点高频重渲染
  const zoomStep = useStore((state) => Math.round((state.transform?.[2] || 1) * 20) / 20)

  if (!selected) return null

  const zoom = zoomStep > 0 ? zoomStep : 1
  // 反补封顶 4 倍：极端缩小下继续加粗会糊成一片
  const compensation = zoom < 1 ? Math.min(1 / zoom, 4) : 1
  const accent = isDark ? '#4C8DFF' : '#2563eb'
  const ringColor = isDark ? 'rgba(76,141,255,0.28)' : 'rgba(37,99,235,0.22)'
  const glowColor = isDark ? 'rgba(76,141,255,0.22)' : 'rgba(37,99,235,0.16)'

  return {
    border: `${2 * compensation}px solid ${accent}`,
    boxShadow:
      `0 0 0 ${4 * compensation}px ${ringColor}, ` +
      `0 0 ${Math.min(22 * compensation, 28)}px ${2 * compensation}px ${glowColor}, ` +
      '0 8px 24px rgba(0,0,0,0.12)',
  }
}
