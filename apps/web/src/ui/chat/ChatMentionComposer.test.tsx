import React from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatMentionComposer, readChatComposer, type ChatMention, type ChatMentionComposerHandle } from './ChatMentionComposer'

afterEach(cleanup)
/** 直接挂载真实编辑器，保留受控正文与引用身份的同步。 */
function mount(value = '', mentions: ChatMention[] = []) {
  const ref = React.createRef<ChatMentionComposerHandle>()
  const changed = vi.fn()
  const keydown = vi.fn()
  function Harness() {
    const [state, setState] = React.useState({ value, mentions })
    return <ChatMentionComposer ref={ref} {...state} minRows={2} maxRows={6} disabled={false} placeholder="正文" onCaretChange={() => {}} onKeyDown={keydown} onChange={(text, caret, next) => { changed(text, caret, next); setState({value: text, mentions: next}) }} />
  }
  const view = render(<Harness />)
  return { ...view, root: view.getByRole('textbox'), ref, changed, keydown }
}
function select(node: Node, start: number, end = start) {
  const range = document.createRange(); range.setStart(node, start); range.setEnd(node, end)
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
}
describe('聊天正文原子引用', () => {
  it('替换查询文本为缩略图与名称标签，保留同名节点身份', () => {
    const {root, ref, changed} = mount('前 @张 后')
    act(() => ref.current!.insertMention({ id:'node-a', label:'张三', imageUrl:'https://example.com/a.png' }, 2, 4))
    expect(readChatComposer(root).value).toBe('前 @张三  后')
    expect(root.querySelector('[data-mention-id]')?.getAttribute('contenteditable')).toBe('false')
    expect(root.querySelector('img')).not.toBeNull()
    expect(changed.mock.lastCall?.[2][0].id).toBe('node-a')
  })
  it.each(['Backspace', 'Delete'])('%s 在标签边界直接删除并同步引用身份', (key) => {
    const mention = {id:'a', label:'甲', start:0, end:2}
    const {root, changed} = mount('@甲', [mention])
    select(root, key === 'Backspace' ? 2 : 0)
    fireEvent.keyDown(root, {key})
    expect(readChatComposer(root)).toEqual({value:'', mentions:[]})
    expect(changed.mock.lastCall?.[2]).toEqual([])
  })
  it('范围删除后同步正文引用，普通同名 @ 文本不是引用', () => {
    const {root, changed} = mount('@甲 和 @甲', [{id:'a',label:'甲',start:0,end:2}])
    const range = document.createRange(); range.selectNode(root.querySelector('[data-mention-id]')!); range.deleteContents()
    fireEvent.input(root)
    expect(readChatComposer(root)).toEqual({value:' 和 @甲',mentions:[]})
    expect(changed.mock.lastCall?.[2]).toEqual([])
  })
  it('全选删除后浏览器唯一占位 BR 同步为空正文并清除引用', () => {
    const {root, changed} = mount('@甲', [{id:'a',label:'甲',start:0,end:2}])
    root.replaceChildren(document.createElement('br'))
    select(root, 0)
    fireEvent.input(root, {inputType:'deleteContentForward'})
    expect(readChatComposer(root)).toEqual({value:'',mentions:[]})
    expect(changed.mock.lastCall).toEqual(['',0,[]])
  })
  it.each(['\n', '\n\n', '甲\n\n乙'])('保留用户正文中的真实空行 %j', (value) => {
    const {root, changed} = mount(value)
    fireEvent.input(root)
    expect(readChatComposer(root).value).toBe(value)
    expect(changed.mock.lastCall?.[0]).toBe(value)
  })
  it('多个 BR 和选区前缀中的单 BR 仍表示真实换行', () => {
    const {root} = mount()
    root.replaceChildren(document.createElement('br'), document.createElement('br'))
    expect(readChatComposer(root).value).toBe('\n\n')
    const range = document.createRange()
    range.setStart(root, 0); range.setEnd(root, 1)
    expect(readChatComposer(range.cloneContents()).value).toBe('\n')
  })
  // jsdom 不执行浏览器编辑；这里只验证 React 路由，实际换行结果由真实 Chrome 回归验证。
  it.each([false, true])('Enter（shift=%s）只调用一次原生纯文本换行', (shiftKey) => {
    const {root, keydown} = mount()
    const original = Object.getOwnPropertyDescriptor(document, 'execCommand')
    const command = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', {configurable:true, value:command})
    try {
      expect(fireEvent.keyDown(root, {key:'Enter', shiftKey})).toBe(false)
      expect(keydown).toHaveBeenCalledTimes(1)
      expect(command).toHaveBeenCalledTimes(1)
      expect(command).toHaveBeenCalledWith('insertText', false, '\n')
    } finally {
      if (original) Object.defineProperty(document, 'execCommand', original)
      else Reflect.deleteProperty(document, 'execCommand')
    }
  })
  it('父组件消费 Enter 后不重复编辑正文', () => {
    const {root, keydown, changed} = mount()
    keydown.mockImplementation((event: React.KeyboardEvent<HTMLDivElement>) => event.preventDefault())
    expect(fireEvent.keyDown(root, {key:'Enter'})).toBe(false)
    expect(changed).not.toHaveBeenCalled()
    expect(readChatComposer(root)).toEqual({value:'', mentions:[]})
  })
  it('IME期间不转发候选快捷键、不提前改写正文', () => {
    const {root, keydown, changed} = mount('')
    fireEvent.compositionStart(root)
    root.textContent = '中文'
    fireEvent.input(root); fireEvent.keyDown(root,{key:'Enter'}); fireEvent.keyDown(root,{key:'ArrowDown'})
    expect(keydown).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled()
    fireEvent.compositionEnd(root)
    expect(changed.mock.lastCall?.[0]).toBe('中文')
  })
  it('浏览器块级换行后仍按正文偏移替换查询', () => {
    const {root, ref} = mount('')
    const first = document.createElement('div'); first.textContent = '第一行'
    const second = document.createElement('div'); second.textContent = '@甲'
    root.replaceChildren(first, second)
    act(() => ref.current!.insertMention({id:'a',label:'甲'}, 4, 6))
    expect(readChatComposer(root)).toEqual({value:'第一行\n@甲 ',mentions:[{id:'a', label:'甲',imageUrl:'',start:4,end:6}]})
  })
  it('组合输入229键码不触发父组件快捷键', () => {
    const {root,keydown} = mount('')
    fireEvent.keyDown(root,{key:'Enter',keyCode:229})
    expect(keydown).not.toHaveBeenCalled()
  })
  it('重新挂载另一布局后保留引用并可继续删除', () => {
    const state = {value:'@甲', mentions:[{id:'a',label:'甲',start:0,end:2}]}
    const first = mount(state.value, state.mentions); first.unmount()
    const second = mount(state.value, state.mentions)
    expect(second.root.querySelector('[data-mention-id="a"]')).not.toBeNull()
    select(second.root,2); fireEvent.keyDown(second.root,{key:'Backspace'})
    expect(readChatComposer(second.root).mentions).toEqual([])
  })
})
