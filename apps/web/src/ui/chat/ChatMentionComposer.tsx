import React from 'react'
import { toOssResponsiveUrl } from '../../canvas/utils/ossResponsive'
import './chatMentionComposer.css'

/** 聊天正文中的原子引用；位置以发送用纯文本的 UTF-16 偏移计算。 */
export interface ChatMention {
  id: string
  label: string
  imageUrl?: string
  start: number
  end: number
}
export interface ChatMentionComposerHandle {
  focus: (options?: FocusOptions) => void
  insertMention: (mention: Omit<ChatMention, 'start' | 'end'>, start: number, end: number) => void
  insertText: (text: string) => void
}
interface Props {
  value: string
  mentions: ChatMention[]
  onChange: (value: string, caret: number, mentions: ChatMention[]) => void
  onCaretChange: (value: string, caret: number) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void
  placeholder: string
  disabled: boolean
  minRows: number
  maxRows: number
  onFocus?: () => void
  className?: string
}

/** 读取正文与标签身份，不通过名称匹配推断引用，避免同名和普通 @ 文本误判。 */
export function readChatComposer(root: Node): { value: string; mentions: ChatMention[] } {
  let value = ''
  const mentions: ChatMention[] = []
  // 浏览器清空编辑器后会留下唯一占位 BR；文本换行、多 BR 和光标测量片段仍是正文。
  if (root instanceof HTMLElement && root.childNodes.length === 1 && root.firstChild instanceof HTMLBRElement) return { value, mentions }
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) { value += node.textContent || ''; return }
    if (node instanceof HTMLElement && node.dataset.mentionId) {
      const label = node.dataset.mentionLabel || ''
      const start = value.length
      value += '@' + label
      mentions.push({ id: node.dataset.mentionId, label, imageUrl: node.dataset.mentionImage, start, end: value.length })
      return
    }
    if (node instanceof HTMLBRElement) { value += '\n'; return }
    const block = node instanceof HTMLElement && (node.tagName === 'DIV' || node.tagName === 'P')
    // 空行块中的唯一 BR 仅撑起光标；换行来自块边界，不能再把占位符计一次。
    if (block && node !== root && node.previousSibling) value += '\n'
    const placeholder = block && node !== root && node.childNodes.length === 1 && node.firstChild instanceof HTMLBRElement
    if (!placeholder) node.childNodes.forEach(visit)
    // 块后若直接接普通文字，也需要保留该行与下一行的分隔。
    const next = node.nextSibling
    if (block && node !== root && next && !(next instanceof HTMLElement && (next.tagName === 'DIV' || next.tagName === 'P'))) value += '\n'
  }
  root.childNodes.forEach(visit)
  return { value, mentions }
}

/** 获取光标在发送用纯文本中的位置，标签整体计入偏移。 */
function caretOffset(root: HTMLElement): number {
  const selection = window.getSelection()
  if (!selection?.rangeCount || !root.contains(selection.anchorNode)) return readChatComposer(root).value.length
  const range = selection.getRangeAt(0).cloneRange()
  range.selectNodeContents(root)
  range.setEnd(selection.anchorNode!, selection.anchorOffset)
  return readChatComposer(range.cloneContents()).value.length
}

/** 按纯文本偏移定位 DOM 边界；原子标签仅允许光标落在前后。 */
function locate(root: HTMLElement, offset: number): { node: Node; offset: number } {
  const measure = (node: Node, end: number): number => {
    const range = document.createRange()
    range.selectNodeContents(root)
    range.setEnd(node, end)
    return readChatComposer(range.cloneContents()).value.length
  }
  const visit = (parent: Node): { node: Node; offset: number } | null => {
    const children = Array.from(parent.childNodes)
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]
      if (child.nodeType === Node.TEXT_NODE) {
        const start = measure(child, 0)
        const length = child.textContent?.length || 0
        if (offset >= start && offset <= start + length) return { node: child, offset: offset - start }
      } else if (child instanceof HTMLElement && child.dataset.mentionId) {
        const start = measure(parent, index)
        const end = measure(parent, index + 1)
        if (offset === start) return { node: parent, offset: index }
        if (offset > start && offset <= end) return { node: parent, offset: index + 1 }
      } else {
        const point = visit(child)
        if (point) return point
      }
    }
    return null
  }
  return visit(root) || { node: root, offset: root.childNodes.length }
}

/** 为聊天提供可整段删除的行内引用；浏览器负责普通文字编辑和组合输入。 */
export const ChatMentionComposer = React.forwardRef<ChatMentionComposerHandle, Props>(function ChatMentionComposer(props, ref) {
  const rootRef = React.useRef<HTMLDivElement>(null)
  const composingRef = React.useRef(false)
  const latestRef = React.useRef(props)
  latestRef.current = props
  const emit = () => {
    const root = rootRef.current
    if (!root) return
    const state = readChatComposer(root)
    latestRef.current.onChange(state.value, caretOffset(root), state.mentions)
  }
  const selectRange = (start: number, end: number): Range | null => {
    const root = rootRef.current
    if (!root) return null
    const from = locate(root, start)
    const to = locate(root, end)
    const range = document.createRange()
    range.setStart(from.node, from.offset)
    range.setEnd(to.node, to.offset)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    return range
  }
  const makeTag = (mention: Omit<ChatMention, 'start' | 'end'>) => {
    const tag = document.createElement('span')
    tag.className = 'tc-chat-mention-composer__tag'
    tag.setAttribute('contenteditable', 'false')
    tag.dataset.mentionId = mention.id
    tag.dataset.mentionLabel = mention.label
    tag.dataset.mentionImage = mention.imageUrl || ''
    if (mention.imageUrl) {
      const image = document.createElement('img')
      image.className = 'tc-chat-mention-composer__thumbnail'
      image.src = toOssResponsiveUrl(mention.imageUrl, 32)
      image.alt = ''
      image.draggable = false
      tag.append(image)
    } else {
      const icon = document.createElement('span')
      icon.className = 'tc-chat-mention-composer__fallback'
      icon.textContent = '@'
      tag.append(icon)
    }
    const label = document.createElement('span')
    label.className = 'tc-chat-mention-composer__label'
    label.textContent = mention.label
    tag.append(label)
    return tag
  }
  const insertText = (text: string) => {
    // 纯文本插入保留浏览器撤销栈，禁止粘贴 HTML 注入或伪造标签。
    document.execCommand('insertText', false, text)
    emit()
  }
  React.useImperativeHandle(ref, () => ({
    focus: (options) => rootRef.current?.focus(options),
    insertText,
    insertMention: (mention, start, end) => {
      const root = rootRef.current
      if (!root) return
      root.focus()
      const range = selectRange(start, end)
      if (!range) return
      range.deleteContents()
      const tag = makeTag(mention)
      range.insertNode(tag)
      const space = document.createTextNode(' ')
      tag.after(space)
      const selection = window.getSelection()
      range.setStart(space, 1)
      range.collapse(true)
      selection?.removeAllRanges()
      selection?.addRange(range)
      emit()
    },
  }))
  React.useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || composingRef.current) return
    const current = readChatComposer(root)
    if (current.value === props.value && JSON.stringify(current.mentions) === JSON.stringify(props.mentions)) return
    const focused = document.activeElement === root
    const caret = focused ? caretOffset(root) : props.value.length
    root.replaceChildren()
    let cursor = 0
    for (const mention of props.mentions) {
      root.append(document.createTextNode(props.value.slice(cursor, mention.start)), makeTag(mention))
      cursor = mention.end
    }
    if (cursor < props.value.length) root.append(document.createTextNode(props.value.slice(cursor)))
    if (focused) selectRange(Math.min(caret, props.value.length), Math.min(caret, props.value.length))
  }, [props.value, props.mentions])
  return <div
    ref={rootRef}
    className={'tc-chat-mention-composer ' + (props.className || '')}
    contentEditable={!props.disabled}
    suppressContentEditableWarning
    role="textbox"
    aria-label={props.placeholder}
    aria-multiline="true"
    aria-disabled={props.disabled}
    data-placeholder={props.placeholder}
    style={{
      minHeight: `calc(${props.minRows} * 1.65em + 4px)`,
      maxHeight: `calc(${props.maxRows} * 1.65em + 4px)`,
    }}
    onFocus={props.onFocus}
    onInput={() => { if (!composingRef.current) emit() }}
    onCompositionStart={() => { composingRef.current = true }}
    onCompositionEnd={() => { composingRef.current = false; emit() }}
    onPaste={(event) => { event.preventDefault(); insertText(event.clipboardData.getData('text/plain')) }}
    onDrop={(event) => event.preventDefault()}
    onKeyUp={(event) => {
      if (['ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(event.key)) return
      const root = rootRef.current
      if (root && !composingRef.current) props.onCaretChange(readChatComposer(root).value, caretOffset(root))
    }}
    onMouseUp={() => {
      const root = rootRef.current
      if (root) props.onCaretChange(readChatComposer(root).value, caretOffset(root))
    }}
    onKeyDown={(event) => {
      if (composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
      props.onKeyDown(event)
      if (event.defaultPrevented) return
      const root = rootRef.current
      const selection = window.getSelection()
      if (root && selection?.isCollapsed && (event.key === 'Backspace' || event.key === 'Delete')) {
        const state = readChatComposer(root)
        const caret = caretOffset(root)
        const mention = state.mentions.find((item) => event.key === 'Backspace' ? item.end === caret : item.start === caret)
        if (mention) {
          event.preventDefault()
          const range = selectRange(mention.start, mention.end)
          range?.deleteContents()
          emit()
        }
      }
      if (event.key === 'Enter') { event.preventDefault(); insertText('\n') }
    }}
  />
})
