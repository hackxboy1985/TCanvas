/**
 * 画布类型角标位置配置（画布配置 → 通用 tab）。
 *
 * <p>两条互斥展示方式：
 * <ul>
 *   <li><b>capsule</b>：角标与一级标题同处标题胶囊内，缩小时不会被上层名牌胶囊遮挡而发暗（默认）；</li>
 *   <li><b>overlay</b>：角标作为浮层居中贴在卡片内部顶部。</li>
 * </ul>
 * 配置存 localStorage，保存后广播事件，画布内所有节点立即生效，无需刷新。</p>
 */
import { useEffect, useState } from 'react'

/** 类型角标位置取值 */
export type CanvasBadgePlacement = 'capsule' | 'overlay'

/** 角标位置变更事件（保存后立即生效） */
export const CANVAS_BADGE_PLACEMENT_CHANGED_EVENT = 'lens:canvasBadgePlacementChanged'

/** localStorage key：类型角标位置 */
export const CANVAS_BADGE_PLACEMENT_STORAGE_KEY = 'lens_canvas_badge_placement'

/** 默认值：角标并进标题胶囊（避免被名牌胶囊遮挡） */
export const DEFAULT_CANVAS_BADGE_PLACEMENT: CanvasBadgePlacement = 'capsule'

/**
 * 读取类型角标位置（localStorage；非法/缺失时回落默认）。
 *
 * @returns 归一化后的角标位置
 */
export function readCanvasBadgePlacement(): CanvasBadgePlacement {
  try {
    const raw = window.localStorage.getItem(CANVAS_BADGE_PLACEMENT_STORAGE_KEY)
    return raw === 'overlay' ? 'overlay' : DEFAULT_CANVAS_BADGE_PLACEMENT
  } catch {
    return DEFAULT_CANVAS_BADGE_PLACEMENT
  }
}

/**
 * 保存类型角标位置：写入 localStorage 并广播变更事件。
 *
 * @param placement 目标位置
 * @returns 实际生效的值
 */
export function saveCanvasBadgePlacement(placement: CanvasBadgePlacement): CanvasBadgePlacement {
  const next: CanvasBadgePlacement = placement === 'overlay' ? 'overlay' : 'capsule'
  try {
    window.localStorage.setItem(CANVAS_BADGE_PLACEMENT_STORAGE_KEY, next)
  } catch {
    // localStorage 不可用（隐私模式/配额）时仅内存生效，不阻塞使用
  }
  window.dispatchEvent(new CustomEvent(CANVAS_BADGE_PLACEMENT_CHANGED_EVENT))
  return next
}

/**
 * 订阅类型角标位置：配置变更（本页保存或其它标签页写入）时自动更新。
 *
 * @returns 当前角标位置
 */
export function useCanvasBadgePlacement(): CanvasBadgePlacement {
  const [placement, setPlacement] = useState<CanvasBadgePlacement>(() => readCanvasBadgePlacement())
  useEffect(() => {
    const sync = () => setPlacement(readCanvasBadgePlacement())
    window.addEventListener(CANVAS_BADGE_PLACEMENT_CHANGED_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(CANVAS_BADGE_PLACEMENT_CHANGED_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])
  return placement
}
