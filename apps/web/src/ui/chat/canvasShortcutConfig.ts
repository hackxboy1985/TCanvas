/**
 * 画布对话快捷键配置（通用 tab：换行键 / 提交生成键，二者互斥）。
 *
 * <p>默认保持现有行为：换行 = Ctrl/⌘+Enter，提交 = Enter。
 * 配置存 localStorage（lens_canvas_shortcut_linebreak / lens_canvas_shortcut_submit），
 * 保存后广播事件，AiChatDialog 立即生效，无需刷新页面。</p>
 */

/** 快捷键取值：enter=回车键；ctrl+enter=Ctrl/⌘+回车键 */
export type CanvasShortcutKey = 'enter' | 'ctrl+enter'

/** 画布对话快捷键配置 */
export interface CanvasShortcutConfig {
  /** 换行快捷键（与提交互斥） */
  lineBreak: CanvasShortcutKey
  /** 提交生成快捷键（与换行互斥） */
  submit: CanvasShortcutKey
}

/** 快捷键配置变更事件（保存后立即生效） */
export const CANVAS_SHORTCUT_CHANGED_EVENT = 'lens:canvasShortcutChanged'

/** localStorage key：换行快捷键 */
export const CANVAS_SHORTCUT_LINEBREAK_STORAGE_KEY = 'lens_canvas_shortcut_linebreak'

/** localStorage key：提交生成快捷键 */
export const CANVAS_SHORTCUT_SUBMIT_STORAGE_KEY = 'lens_canvas_shortcut_submit'

/** 默认配置：换行=ctrl+enter、提交=enter（保持现有行为） */
export const DEFAULT_CANVAS_SHORTCUT_CONFIG: CanvasShortcutConfig = {
  lineBreak: 'ctrl+enter',
  submit: 'enter',
}

/**
 * 把任意字符串归一为合法快捷键取值。
 *
 * @param value         原始值
 * @param fallbackValue 无法识别时的回退值
 * @returns 归一化取键
 */
function normalizeShortcutKey(value: string | null, fallbackValue: CanvasShortcutKey): CanvasShortcutKey {
  if (value === 'enter') return 'enter'
  if (value === 'ctrl+enter') return 'ctrl+enter'
  return fallbackValue
}

/**
 * 求与给定快捷键互斥的另一个快捷键。
 *
 * @param key 快捷键
 * @returns 相反快捷键
 */
export function oppositeCanvasShortcutKey(key: CanvasShortcutKey): CanvasShortcutKey {
  return key === 'enter' ? 'ctrl+enter' : 'enter'
}

/**
 * 读取快捷键配置（localStorage；非法/缺失时回落默认）。
 *
 * @returns 归一化后的快捷键配置（两值保证互斥）
 */
export function readCanvasShortcutConfig(): CanvasShortcutConfig {
  try {
    const lineBreak = normalizeShortcutKey(
      window.localStorage.getItem(CANVAS_SHORTCUT_LINEBREAK_STORAGE_KEY),
      DEFAULT_CANVAS_SHORTCUT_CONFIG.lineBreak,
    )
    const submit = normalizeShortcutKey(
      window.localStorage.getItem(CANVAS_SHORTCUT_SUBMIT_STORAGE_KEY),
      lineBreak === 'enter' ? 'ctrl+enter' : 'enter',
    )
    // 互斥兜底：两者相同（历史脏数据）时以换行配置为准推导提交配置
    if (lineBreak === submit) {
      return { lineBreak, submit: oppositeCanvasShortcutKey(lineBreak) }
    }
    return { lineBreak, submit }
  } catch {
    return { ...DEFAULT_CANVAS_SHORTCUT_CONFIG }
  }
}

/**
 * 保存快捷键配置：强制互斥（提交 = 与换行相反），写入 localStorage 并广播变更事件。
 *
 * @param config 期望保存的配置（只需改动的那个字段；另一个会自动取反）
 * @returns 实际生效的配置
 */
export function saveCanvasShortcutConfig(config: CanvasShortcutConfig): CanvasShortcutConfig {
  const lineBreak: CanvasShortcutKey = config.lineBreak === 'enter' ? 'enter' : 'ctrl+enter'
  const submit: CanvasShortcutKey = oppositeCanvasShortcutKey(lineBreak)
  const normalized: CanvasShortcutConfig = { lineBreak, submit }
  try {
    window.localStorage.setItem(CANVAS_SHORTCUT_LINEBREAK_STORAGE_KEY, lineBreak)
    window.localStorage.setItem(CANVAS_SHORTCUT_SUBMIT_STORAGE_KEY, submit)
  } catch {
    // localStorage 不可用（隐私模式/配额）时仅内存生效，不阻塞使用
  }
  window.dispatchEvent(new CustomEvent(CANVAS_SHORTCUT_CHANGED_EVENT))
  return normalized
}
