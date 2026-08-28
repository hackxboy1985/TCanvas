import React from 'react'
import { PanelCard } from '../../../../ui/PanelCard'

type TextContentProps = {
  selected: boolean
  textEditorFocused: boolean
  textBackgroundTint: string
  textColor: string
  textFontSize: number
  textFontWeight: React.CSSProperties['fontWeight']
  editorRef: React.RefObject<HTMLDivElement | null>
  onFocus: React.FocusEventHandler<HTMLDivElement>
  onInput: React.FormEventHandler<HTMLDivElement>
  onCompositionStart: React.CompositionEventHandler<HTMLDivElement>
  onCompositionEnd: React.CompositionEventHandler<HTMLDivElement>
  onBlur: React.FocusEventHandler<HTMLDivElement>
}

const SCROLL_EPSILON = 1

const canScrollVertically = (element: HTMLDivElement, deltaY: number): boolean => {
  if (Math.abs(deltaY) < SCROLL_EPSILON) return false
  const maxScrollTop = element.scrollHeight - element.clientHeight
  if (maxScrollTop <= SCROLL_EPSILON) return false
  if (deltaY < 0) return element.scrollTop > SCROLL_EPSILON
  return element.scrollTop < maxScrollTop - SCROLL_EPSILON
}

export function TextContent({
  selected,
  textEditorFocused,
  textBackgroundTint,
  textColor,
  textFontSize,
  textFontWeight,
  editorRef,
  onFocus,
  onInput,
  onCompositionStart,
  onCompositionEnd,
  onBlur,
}: TextContentProps) {
  // 双击进入编辑态：默认展示态只可拖拽/选中，双击后才允许编辑
  const [editRequested, setEditRequested] = React.useState(false)
  const editing = editRequested || textEditorFocused

  const handleWheelCapture: React.WheelEventHandler<HTMLDivElement> = (event) => {
    const editor = editorRef.current
    if (!editor) return
    if (event.ctrlKey || event.metaKey) return
    if (!canScrollVertically(editor, event.deltaY)) return
    event.stopPropagation()
  }

  const handleDoubleClick = () => {
    setEditRequested(true)
    const editor = editorRef.current
    if (editor) editor.focus()
  }

  const handleBlur: React.FocusEventHandler<HTMLDivElement> = (event) => {
    setEditRequested(false)
    onBlur(event)
  }

  const editorClassName = [
    'tc-task-node__text-editor-input',
    editing ? 'nodrag nopan' : '',
  ].filter(Boolean).join(' ')

  return (
    <PanelCard
      className="tc-task-node__text-editor-panel"
      padding="compact"
      style={{
        width: '100%',
        backgroundColor: textBackgroundTint,
        display: 'flex',
        flex: 1,
        minHeight: 0,
      }}
      onWheelCapture={handleWheelCapture}
    >
      <div
        ref={editorRef}
        className={editorClassName}
        contentEditable={editing}
        suppressContentEditableWarning
        onDoubleClick={handleDoubleClick}
        onWheelCapture={handleWheelCapture}
        onFocus={onFocus}
        onInput={onInput}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        onBlur={handleBlur}
        tabIndex={editing ? 0 : -1}
        style={{
          flex: 1,
          minHeight: 0,
          height: '100%',
          outline: 'none',
          border: 'none',
          background: 'transparent',
          color: textColor,
          fontSize: textFontSize,
          fontWeight: textFontWeight,
          lineHeight: 1.5,
          padding: 0,
          overflowY: 'auto',
          paddingRight: 4,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          // 编辑态光标为文本输入，展示态为可拖拽抓手
          cursor: editing ? 'text' : 'grab',
        }}
      />
    </PanelCard>
  )
}
