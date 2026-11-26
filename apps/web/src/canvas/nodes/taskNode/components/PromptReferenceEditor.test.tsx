import React, { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { PromptReferenceEditor, readPromptDOM, type PromptReferenceEditorHandle } from './PromptReferenceEditor'

const references = [{ token: '@小明（外套）', label: '小明（外套）', imageUrl: 'https://example.com/a.png' }, { token: '@小明', label: '小明' }]
/** jsdom 无原生编辑命令，仅模拟已经选中的 DOM 删除；真实按键仍需浏览器验证。 */
function mockDelete() {
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => {
    const selection = window.getSelection()
    selection?.getRangeAt(0).deleteContents()
    selection?.collapseToStart()
    return true
  }) })
}
describe('提示词原子引用', () => {
  it('公开选区接口保留起止点，引用图片更新后仍保留跨标签选区', () => {
    const ref = createRef<PromptReferenceEditorHandle>()
    const value = '前@小明后'
    const { getByRole, rerender } = render(<PromptReferenceEditor ref={ref} value={value} references={references} onChange={() => {}} />)
    const editor = getByRole('textbox')
    editor.focus()
    ref.current!.setSelectionRange(0, value.length)
    expect(readPromptDOM(window.getSelection()!.getRangeAt(0).cloneContents())).toBe(value)
    rerender(<PromptReferenceEditor ref={ref} value={value} references={[{ token: '@小明', label: '新名称' }]} onChange={() => {}} />)
    expect(readPromptDOM(window.getSelection()!.getRangeAt(0).cloneContents())).toBe(value)
  })
  it('反向选区在引用重绘后保持方向与内容', () => {
    const ref = createRef<PromptReferenceEditorHandle>()
    const { getByRole, rerender } = render(<PromptReferenceEditor ref={ref} value="前@小明后" references={references} onChange={() => {}} />)
    const editor = getByRole('textbox')
    editor.focus()
    ref.current!.setSelectionRange(5, 0)
    rerender(<PromptReferenceEditor ref={ref} value="前@小明后" references={[{token:'@小明',label:'新姓名'}]} onChange={() => {}} />)
    expect(ref.current!.selectionStart).toBe(5)
    expect(readPromptDOM(window.getSelection()!.getRangeAt(0).cloneContents())).toBe('前@小明后')
  })
  it.each(['Backspace', 'Delete'])('选区%s交给原生编辑并在input发布，不额外吞掉其他引用', key => {
    mockDelete()
    const change = vi.fn()
    const { getByRole } = render(<PromptReferenceEditor value="前@小明后@小明" references={references} onChange={change} />)
    const editor = getByRole('textbox')
    const range = document.createRange()
    range.setStart(editor.firstChild!, 0)
    range.setEndAfter(editor.querySelector('[data-prompt-token]')!)
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
    expect(fireEvent.keyDown(editor, { key })).toBe(true)
    expect(document.execCommand).not.toHaveBeenCalled()
    // jsdom 没有默认编辑动作，显式模拟浏览器删除选区后的 input。
    range.deleteContents()
    fireEvent.input(editor)
    expect(change.mock.calls[0][0].currentTarget.value).toBe('后@小明')
    expect(editor.querySelectorAll('[data-prompt-token]')).toHaveLength(1)
  })
  it('组合输入期间不发布中间值也不删除引用，结束后发布最终纯文本', () => {
    mockDelete()
    const change = vi.fn()
    const keydown = vi.fn()
    const { getByRole } = render(<PromptReferenceEditor value="@小明" references={references} onChange={change} onKeyDown={keydown} />)
    const editor = getByRole('textbox')
    const range = document.createRange()
    range.selectNodeContents(editor); range.collapse(false)
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
    fireEvent.compositionStart(editor)
    editor.append(document.createTextNode('中文'))
    fireEvent.input(editor)
    fireEvent.keyDown(editor, { key: 'Backspace', isComposing: true })
    fireEvent.keyDown(editor, { key: 'Enter', isComposing: true })
    expect(keydown).not.toHaveBeenCalled()
    expect(change).not.toHaveBeenCalled()
    expect(document.execCommand).not.toHaveBeenCalled()
    fireEvent.compositionEnd(editor)
    expect(change.mock.calls[0][0].currentTarget.value).toBe('@小明中文')
  })
  it('复制和剪切引用均输出原始token而不是标签名称', () => {
    mockDelete()
    const change = vi.fn()
    const { getByRole } = render(<PromptReferenceEditor value="前@小明后" references={[{token:'@小明',label:'显示姓名'}]} onChange={change} />)
    const editor = getByRole('textbox')
    const range = document.createRange()
    range.selectNode(editor.querySelector('[data-prompt-token]')!)
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
    const setData = vi.fn()
    fireEvent.copy(editor, { clipboardData: { setData } })
    expect(setData).toHaveBeenLastCalledWith('text/plain', '@小明')
    setData.mockClear()
    fireEvent.cut(editor, { clipboardData: { setData } })
    expect(setData).toHaveBeenLastCalledWith('text/plain', '@小明')
    expect(readPromptDOM(editor)).toBe('前后')
    expect(change).toHaveBeenCalled()
  })
  it('浏览器空行占位BR不重复序列化换行', () => {
    const { getByRole } = render(<PromptReferenceEditor value="" references={[]} onChange={() => {}} />)
    const editor = getByRole('textbox')
    editor.innerHTML = '第一行<div><br></div><div>第三行</div>'
    expect(readPromptDOM(editor)).toBe('第一行\n\n第三行')
  })
  it('最长名称优先，原文及 JSON 换行完整保留并使用缩略图', () => {
    const value = '{"人物":"@小明（外套）"}\n@小明'
    const { getByRole } = render(<PromptReferenceEditor value={value} references={references} onChange={() => {}} />)
    const editor = getByRole('textbox')
    expect(readPromptDOM(editor)).toBe(value)
    expect(editor.querySelectorAll('[data-prompt-token]')).toHaveLength(2)
    expect(editor.querySelector('img')?.src).toContain('x-oss-process=image/resize,w_100')
  })
  it.each(['Backspace', 'Delete'])('%s 紧邻时直接删除，不要求先选中', key => {
    mockDelete()
    const change = vi.fn()
    const { getByRole, unmount } = render(<PromptReferenceEditor value="前@小明后" references={references} onChange={change} />)
    const editor = getByRole('textbox')
    const chip = editor.querySelector('[data-prompt-token]')!
    const range = document.createRange()
    if (key === 'Backspace') range.setStartAfter(chip)
    else range.setStartBefore(chip)
    range.collapse(true)
    const selection = window.getSelection()!
    selection.removeAllRanges(); selection.addRange(range)
    fireEvent.keyDown(editor, { key })
    expect(readPromptDOM(editor)).toBe('前后')
    expect(change).toHaveBeenCalled()
    unmount()
  })
  it('中文组合输入和只读态不响应标签退格', () => {
    mockDelete()
    const { getByRole } = render(<PromptReferenceEditor value="@小明" references={references} onChange={() => {}} readOnly />)
    fireEvent.keyDown(getByRole('textbox'), { key: 'Backspace' })
    expect(document.execCommand).not.toHaveBeenCalled()
  })
})
