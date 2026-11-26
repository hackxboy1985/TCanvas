import React, { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import { toOssResponsiveUrl } from '../../../utils/ossResponsive'
import './PromptReferenceEditor.css'

/** 引用只负责显示；token 为已有原始文本，不触碰业务关系。 */
export interface PromptReference {
  /** 持久化/回传的原始 token。 */
  token: string
  /** 芯片展示文本；缺省时使用 token。 */
  displayToken?: string
  /** 允许命中的正文别名；序列化始终仍使用 token。 */
  matchTokens?: string[]
  label: string
  imageUrl?: string | null
}
export interface PromptReferenceEditorHandle {
  value: string
  selectionStart: number
  focus: () => void
  setSelectionRange: (start: number, end: number) => void
  getBoundingClientRect: () => DOMRect
  getCaretRect: () => DOMRect
}
interface Props {
  value: string
  references: PromptReference[]
  /** 显式 @ 段作为整体匹配，禁止正文别名进入未识别的段。 */
  protectExplicitMentions?: boolean
  onChange: (event: { currentTarget: PromptReferenceEditorHandle }) => void
  className?: string
  placeholder?: string
  readOnly?: boolean
  minRows?: number
  maxRows?: number
  onClick?: React.MouseEventHandler<HTMLDivElement>
  onKeyUp?: React.KeyboardEventHandler<HTMLDivElement>
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>
  onSelect?: React.ReactEventHandler<HTMLDivElement>
  onBlur?: React.FocusEventHandler<HTMLDivElement>
}

/** 按原始 token 序列化，显示名称和图片不会混进提示词。 */
export function readPromptDOM(node: Node): string {
  if (node instanceof HTMLElement && node.dataset.promptToken !== undefined) return node.dataset.promptToken
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || ''
  if (node.nodeName === 'BR') return '\n'
  // 浏览器空行中的唯一 BR 是光标占位，不额外贡献换行。
  if ((node.nodeName === 'DIV' || node.nodeName === 'P') && node.childNodes.length === 1 && node.firstChild?.nodeName === 'BR') return ''
  return Array.from(node.childNodes).map((child, index) => {
    const block = child.nodeName === 'DIV' || child.nodeName === 'P'
    return (block && index > 0 ? '\n' : '') + readPromptDOM(child)
  }).join('')
}
/** 使用序列化文本偏移，保持标签前后光标与原字符串一致。 */
function caretOffset(root: HTMLElement, focus = false): number {
  const selection = window.getSelection()
  if (!selection?.rangeCount || !root.contains(selection.anchorNode)) return readPromptDOM(root).length
  const range = selection.getRangeAt(0).cloneRange()
  range.selectNodeContents(root)
  range.setEnd((focus ? selection.focusNode : selection.anchorNode)!, focus ? selection.focusOffset : selection.anchorOffset)
  return readPromptDOM(range.cloneContents()).length
}
function placeCaret(root: HTMLElement, offset: number): Range {
  const range = document.createRange()
  let remaining = offset
  const visit = (node: Node): boolean => {
    if (node instanceof HTMLElement && node.dataset.promptToken !== undefined) {
      const length = node.dataset.promptToken.length
      if (remaining <= length) {
        if (remaining === 0) range.setStartBefore(node)
        else range.setStartAfter(node)
        return true
      }
      remaining -= length
      return false
    }
    if (node.nodeType === Node.TEXT_NODE) {
      if (remaining <= (node.textContent?.length || 0)) { range.setStart(node, remaining); return true }
      remaining -= node.textContent?.length || 0
      return false
    }
    for (const child of Array.from(node.childNodes)) if (visit(child)) return true
    return false
  }
  if (!visit(root)) { range.selectNodeContents(root); range.collapse(false) }
  range.collapse(true)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  return range
}
/** 重绘时恢复两端及反向选择，不能把选区压缩成一个光标。 */
function placeSelection(root: HTMLElement, start: number, end: number): void {
  const anchor = placeCaret(root, start)
  const focus = placeCaret(root, end)
  window.getSelection()?.setBaseAndExtent(anchor.startContainer, anchor.startOffset, focus.startContainer, focus.startOffset)
}

/** 参考 RuoYi 原子标签交互，复用 OSS 缩略图及浏览器编辑历史。 */
export const PromptReferenceEditor = forwardRef<PromptReferenceEditorHandle, Props>(function PromptReferenceEditor(props, ref) {
  const rootRef = useRef<HTMLDivElement>(null)
  const composing = useRef(false)
  const latest = useRef(props)
  latest.current = props
  const handle: PromptReferenceEditorHandle = {
    get value() { return rootRef.current ? readPromptDOM(rootRef.current) : latest.current.value },
    get selectionStart() { return rootRef.current ? caretOffset(rootRef.current) : 0 },
    focus() { rootRef.current?.focus() },
    setSelectionRange(start, end) { if (rootRef.current) placeSelection(rootRef.current, start, end) },
    getBoundingClientRect() { return rootRef.current?.getBoundingClientRect() || new DOMRect() },
    getCaretRect() { const selection = window.getSelection(); return selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : this.getBoundingClientRect() },
  }
  useImperativeHandle(ref, () => handle)
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || composing.current) return
    const focused = document.activeElement === root
    const offset = focused ? caretOffset(root) : 0
    const focusOffset = focused ? caretOffset(root, true) : 0
    const references = [...props.references]
      .filter(item => item.token)
      .flatMap((item) => {
        const candidates = [item.token, item.displayToken || '', ...(item.matchTokens || [])]
          .filter(Boolean)
          .filter((candidate, index, list) => list.indexOf(candidate) === index)
        return candidates.map((matchToken) => ({ item, matchToken }))
      })
      .sort((a, b) => b.matchToken.length - a.matchToken.length)
    const fragment = document.createDocumentFragment()
    let cursor = 0
    let plain = ''
    const flush = () => { if (plain) { fragment.append(document.createTextNode(plain)); plain = '' } }
    const explicitBoundary = /[\s,，。！？、；;:：!?"'\]}>）)]/
    while (cursor < props.value.length) {
      const explicit = props.protectExplicitMentions && props.value[cursor] === '@'
      const match = references.find(({ matchToken }) => {
        if (!props.value.startsWith(matchToken, cursor)) return false
        if (!explicit) return true
        const next = props.value[cursor + matchToken.length]
        return matchToken.startsWith('@') && (!next || explicitBoundary.test(next))
      })
      if (!match) {
        plain += props.value[cursor++]
        if (explicit) {
          while (cursor < props.value.length && props.value[cursor] !== '@' && !explicitBoundary.test(props.value[cursor])) {
            plain += props.value[cursor++]
          }
        }
        continue
      }
      const item = match.item
      flush()
      const chip = document.createElement('span')
      chip.className = 'prompt-reference-editor__chip'
      chip.contentEditable = 'false'
      chip.dataset.promptToken = item.token
      chip.title = item.token
      if (item.imageUrl) {
        const image = document.createElement('img')
        image.className = 'prompt-reference-editor__image'
        image.src = toOssResponsiveUrl(item.imageUrl, 48)
        image.alt = ''
        image.draggable = false
        chip.append(image)
      }
      const label = document.createElement('span')
      label.className = 'prompt-reference-editor__label'
      label.textContent = item.label
      chip.append(label)
      fragment.append(chip)
      cursor += match.matchToken.length
    }
    flush()
    // 普通输入不重建 DOM，避免打断输入法、原生撤销栈及选区。
    const probe = document.createElement('div')
    probe.append(fragment)
    if (root.innerHTML === probe.innerHTML) return
    root.replaceChildren(...Array.from(probe.childNodes))
    if (focused) placeSelection(root, offset, focusOffset)
  }, [props.value, props.references, props.protectExplicitMentions])
  const emit = () => latest.current.onChange({ currentTarget: handle })
  const removeAdjacent = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (props.readOnly || composing.current || event.nativeEvent.isComposing || event.altKey || event.metaKey || event.ctrlKey) return
    if (event.key !== 'Backspace' && event.key !== 'Delete') return
    const root = rootRef.current
    const selection = window.getSelection()
    if (!root || !selection?.rangeCount || !selection.isCollapsed || !root.contains(selection.anchorNode)) return
    const offset = caretOffset(root)
    let position = 0
    const value = readPromptDOM(root)
    for (const node of Array.from(root.childNodes)) {
      const length = readPromptDOM(node).length
      if (node instanceof HTMLElement && node.dataset.promptToken !== undefined &&
        (event.key === 'Backspace'
          ? position + length === offset || (position + length + 1 === offset && value[position + length] === ' ')
          : position === offset)) {
        event.preventDefault()
        const range = document.createRange()
        range.selectNode(node)
        // @候选插入后的一个分隔空格可随退格移除，不吞掉用户其他空白。
        if (event.key === 'Backspace' && position + length < offset && node.nextSibling?.nodeType === Node.TEXT_NODE) range.setEnd(node.nextSibling, 1)
        selection.removeAllRanges()
        selection.addRange(range)
        document.execCommand('delete')
        emit()
        return
      }
      position += length
    }
  }
  return <div
    ref={rootRef}
    className={['prompt-reference-editor', 'nodrag', 'nopan', props.className].filter(Boolean).join(' ')}
    contentEditable={!props.readOnly}
    suppressContentEditableWarning
    role="textbox"
    aria-label={props.placeholder || '提示词'}
    aria-multiline="true"
    aria-readonly={props.readOnly}
    data-placeholder={props.placeholder}
    style={{ minHeight: 'calc(' + (props.minRows ?? 2) + ' * 1.6em + 16px)', maxHeight: 'calc(' + (props.maxRows ?? 6) + ' * 1.6em + 16px)' }}
    onInput={() => { if (!composing.current) emit() }}
    onCompositionStart={() => { composing.current = true }}
    onCompositionEnd={() => { composing.current = false; emit() }}
    onPaste={event => { if (props.readOnly) return; event.preventDefault(); document.execCommand('insertText', false, event.clipboardData.getData('text/plain')); emit() }}
    onCopy={event => { const selection = window.getSelection(); if (!selection?.rangeCount) return; event.preventDefault(); event.clipboardData.setData('text/plain', readPromptDOM(selection.getRangeAt(0).cloneContents())) }}
    onCut={event => {
      if (props.readOnly) return
      const selection = window.getSelection()
      if (!selection?.rangeCount) return
      event.preventDefault()
      event.clipboardData.setData('text/plain', readPromptDOM(selection.getRangeAt(0).cloneContents()))
      document.execCommand('delete')
      emit()
    }}
    onKeyDown={event => {
      // 组合输入的确认键不能先交给 @候选菜单，否则 Enter 会替换正在输入的中文。
      if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return
      props.onKeyDown?.(event)
      if (!event.defaultPrevented) removeAdjacent(event)
    }}
    onClick={props.onClick} onKeyUp={props.onKeyUp} onSelect={props.onSelect} onBlur={props.onBlur}
  />
})
