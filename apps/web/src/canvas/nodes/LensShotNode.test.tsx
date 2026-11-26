// @vitest-environment jsdom
import React, { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { Node } from '@xyflow/react'
import { collectShotPromptAssets, ShotPromptEditor, shotPromptForModel, type LensShotRef } from './LensShotNode'
import { readPromptDOM } from './taskNode/components/PromptReferenceEditor'

const canvas = vi.hoisted(() => ({ nodes: [] as Node[] }))
vi.mock('../store', () => ({ useRFStore: { getState: () => canvas } }))
vi.mock('../../ui/uiStore', () => ({ useUIStore: vi.fn() }))
vi.mock('../../api/lens', () => ({}))
vi.mock('../../api/server', () => ({}))
vi.mock('../../config/useModelOptions', () => ({}))
vi.mock('./taskNodeHelpers', () => ({}))
vi.mock('./taskNode/components/VideoFramePreview', () => ({}))
vi.mock('../components/LensReferencePicker', () => ({}))

function asset(id: string, category: number, label: string, fields: Record<string, unknown> = {}): Node {
  return { id: category + ':' + id, type: 'taskNode', position: { x: 0, y: 0 }, data: {
    source: 'lens_projection', entityId: id, assetCategory: category, label, ...fields,
  } }
}

function Composer({ initial = '', mode = 'prompt', refs = [] }: { initial?: string; mode?: 'prompt' | 'script'; refs?: LensShotRef[] }) {
  const [value, setValue] = useState(initial)
  return <ShotPromptEditor mode={mode} value={value} refs={refs} onChange={setValue} />
}

/** jsdom 不执行输入默认动作，模拟浏览器更新文本和光标后派发 input。 */
function enterText(editor: HTMLElement, text: string, caret = text.length): void {
  editor.focus()
  const node = document.createTextNode(text)
  editor.replaceChildren(node)
  window.getSelection()?.collapse(node, caret)
  fireEvent.input(editor)
}

afterEach(() => { cleanup(); canvas.nodes = [] })

describe('分镜提示词的画布资产候选', () => {
  it('包含角色、子角色、场景、子场景及无图道具，排除站位和普通节点', () => {
    canvas.nodes = [
      asset('1', 1, '小明'), asset('2', 1, '小明', { parentEntityId: '1', cloneName: '外套' }),
      asset('1', 2, '街道'), asset('2', 2, '街道（夜景）', { parentEntityId: '1', variantName: '夜景' }),
      asset('1', 3, '背包'), asset('1', 4, '站位'), asset('3', 1, '普通', { source: '' }),
    ]
    expect(collectShotPromptAssets(canvas.nodes).map(ref => ref.name)).toEqual(['小明', '小明（外套）', '街道', '街道（夜景）', '背包'])
    const ui = render(<Composer />)
    enterText(ui.getByRole('textbox'), '@')
    expect(ui.getAllByRole('option')).toHaveLength(5)
  })

  it('上下键与回车选中同名资产的正确身份，原子缩略图与光标位置正确', () => {
    canvas.nodes = [asset('1', 1, '海边', { imageUrl: '/role.png' }), asset('1', 2, '海边', { imageUrl: '/scene.png' })]
    const ui = render(<Composer />)
    const editor = ui.getByRole('textbox')
    enterText(editor, '前@海 后', 3)
    expect(fireEvent.keyDown(editor, { key: 'ArrowUp' })).toBe(false)
    expect(ui.getAllByRole('option')[1].getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(editor, { key: 'ArrowDown' })
    fireEvent.keyDown(editor, { key: 'ArrowDown' })
    expect(fireEvent.keyDown(editor, { key: 'Enter' })).toBe(false)
    expect(ui.queryByRole('listbox')).toBeNull()
    const chip = editor.querySelector<HTMLElement>('[data-prompt-token]')!
    expect(chip.dataset.promptToken).toContain('lens-asset:2:1:')
    expect(chip.textContent).toBe('海边')
    expect(chip.querySelector('img')?.getAttribute('src')).toContain('/scene.png')
    expect(shotPromptForModel(readPromptDOM(editor))).toBe('前@海边  后')
    const prefix = document.createRange()
    prefix.selectNodeContents(editor)
    const selection = window.getSelection()!
    prefix.setEnd(selection.anchorNode!, selection.anchorOffset)
    expect(readPromptDOM(prefix.cloneContents())).toBe('前' + chip.dataset.promptToken + ' ')
    const saved = readPromptDOM(editor)
    ui.unmount()
    const restored = render(<Composer initial={saved} />)
    expect(restored.getByRole('textbox').querySelector('img')?.getAttribute('src')).toContain('/scene.png')
  })

  it('保留业务正文别名，Esc 保留查询正文，剧本模式不弹候选', () => {
    const refs = [{ category: 1, id: '1', name: '小明（外套）', baseName: '小明', imgUrl: '/role.png' }]
    const ui = render(<Composer initial="小明进门" refs={refs} />)
    const editor = ui.getByRole('textbox')
    expect(editor.querySelector('[data-prompt-token]')?.textContent).toBe('小明（外套）')
    enterText(editor, '@待搜索')
    expect(ui.getByRole('listbox')).toBeTruthy()
    expect(fireEvent.keyDown(editor, { key: 'Escape' })).toBe(false)
    expect(ui.queryByRole('listbox')).toBeNull()
    expect(readPromptDOM(editor)).toBe('@待搜索')
    ui.unmount()
    const script = render(<Composer mode="script" />)
    enterText(script.getByRole('textbox'), '@')
    expect(script.queryByRole('listbox')).toBeNull()
  })

  it('不会选中已离开画布的资产，输入法确认键不提交候选', () => {
    canvas.nodes = [asset('1', 1, '小明')]
    const ui = render(<Composer />)
    const editor = ui.getByRole('textbox')
    enterText(editor, '@小')
    expect(fireEvent.keyDown(editor, { key: 'Enter', isComposing: true })).toBe(true)
    expect(ui.getByRole('option')).toBeTruthy()
    canvas.nodes = []
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(readPromptDOM(editor)).toBe('@小')
    expect(ui.queryByRole('listbox')).toBeNull()
  })

  it('同名资产只在当前会话按身份选择，重开不猜测，JSON 名称保持合法', () => {
    canvas.nodes = [asset('1', 1, '引号"角色'), asset('2', 1, '引号"角色')]
    const ui = render(<Composer />)
    const json = '{"prompt":"@引号"}'
    enterText(ui.getByRole('textbox'), json, json.indexOf('号') + 1)
    expect(ui.getAllByRole('option')).toHaveLength(2)
    fireEvent.keyDown(ui.getByRole('textbox'), { key: 'Enter' })
    const saved = readPromptDOM(ui.getByRole('textbox'))
    expect(saved).toContain('@[')
    const businessPrompt = shotPromptForModel(saved)
    expect(businessPrompt).not.toContain('lens-asset:')
    expect(JSON.parse(businessPrompt)).toEqual({ prompt: '@引号"角色 ' })
    ui.unmount()
    const reopened = render(<Composer initial={businessPrompt} refs={[{ id: '2', category: 1, name: '引号"角色' }]} />)
    expect(reopened.getByRole('textbox').querySelectorAll('[data-prompt-token]')).toHaveLength(0)
  })

  it('仅恢复有结束边界的显式名称，避免短名吞掉长名', () => {
    canvas.nodes = [asset('1', 1, '小明')]
    const ui = render(<Composer initial="@小明明 @小明（外套）" />)
    expect(ui.getByRole('textbox').querySelector('[data-prompt-token]')).toBeNull()
    ui.unmount()
    const exact = render(<Composer initial="镜头对准@小明。" />)
    expect(exact.getByRole('textbox').querySelector('[data-prompt-token]')?.textContent).toBe('小明')
  })

  it('未识别的显式段不吞掉内部别名，段外正文保留别名匹配', () => {
    const refs = [{ id: '1', category: 1, name: '小明（外套）', baseName: '小明' }]
    const ui = render(<Composer initial="@未知小明 小明进门" refs={refs} />)
    const editor = ui.getByRole('textbox')
    expect(editor.querySelectorAll('[data-prompt-token]')).toHaveLength(1)
    expect(readPromptDOM(editor)).toBe('@未知小明 @小明（外套）进门')
  })

  it('显式业务名逐位置判断边界，完整名称仍可匹配', () => {
    const refs = [{ id: '1', category: 1, name: '小明' }]
    const ui = render(<Composer initial="@小明明 @小明（外套） @小明。" refs={refs} />)
    const editor = ui.getByRole('textbox')
    expect(editor.querySelectorAll('[data-prompt-token]')).toHaveLength(1)
    expect(editor.firstChild?.textContent).toBe('@小明明 @小明（外套） ')
  })

  it('复制和剪切输出可读名称且清除无效会话标记', () => {
    canvas.nodes = [asset('1', 1, '小明')]
    const ui = render(<Composer />)
    const editor = ui.getByRole('textbox')
    enterText(editor, '@小')
    fireEvent.keyDown(editor, { key: 'Enter' })
    const selection = window.getSelection()!
    selection.selectAllChildren(editor)
    const setData = vi.fn()
    const clipboardData = { setData }
    fireEvent.copy(editor, { clipboardData })
    expect(setData).toHaveBeenLastCalledWith('text/plain', '@小明 ')
    const original = Object.getOwnPropertyDescriptor(document, 'execCommand')
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => {
      selection.getRangeAt(0).deleteContents()
      return true
    } })
    try {
      fireEvent.cut(editor, { clipboardData })
      expect(setData).toHaveBeenCalledTimes(2)
      expect(setData).toHaveBeenLastCalledWith('text/plain', '@小明 ')
      expect(readPromptDOM(editor)).toBe('')
    } finally {
      if (original) Object.defineProperty(document, 'execCommand', original)
      else Reflect.deleteProperty(document, 'execCommand')
    }
    expect(shotPromptForModel('@[lens-asset:1:1:%GG] @[lens-asset:bad')).toBe('@ @')
  })
})
