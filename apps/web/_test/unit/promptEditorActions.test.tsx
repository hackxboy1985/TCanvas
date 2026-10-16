import React from 'react'
import { MantineProvider } from '@mantine/core'
import { fireEvent, render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PromptEditorActions } from '../../src/canvas/nodes/taskNode/components/PromptEditorActions'

afterEach(cleanup)

function mount(isAdmin = false, hasStructuredPrompt = true, readOnly = false) {
  const onRefine = vi.fn()
  const onModeChange = vi.fn()
  render(<MantineProvider><PromptEditorActions
    isAdmin={isAdmin} hasStructuredPrompt={hasStructuredPrompt} structured={false}
    loading={false} readOnly={readOnly} onRefine={onRefine} onModeChange={onModeChange}
  /></MantineProvider>)
  return { onRefine, onModeChange }
}

describe('提示词润色与 JSON 展示分离', () => {
  it('普通用户可润色但看不到 JSON 开关', () => {
    const callbacks = mount()
    expect(screen.queryByRole('switch')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'AI 润色' }))
    expect(callbacks.onRefine).toHaveBeenCalledOnce()
    expect(callbacks.onModeChange).not.toHaveBeenCalled()
  })
  it('管理员切换 JSON 不调用 AI 润色', () => {
    const callbacks = mount(true)
    fireEvent.click(screen.getByRole('switch', { name: 'JSON' }))
    expect(callbacks.onModeChange).toHaveBeenCalledWith(true)
    expect(callbacks.onRefine).not.toHaveBeenCalled()
  })
  it('没有结构化结果时禁用 JSON，不隐式请求 AI', () => {
    const callbacks = mount(true, false)
    expect((screen.getByRole('switch') as HTMLInputElement).disabled).toBe(true)
    expect(callbacks.onRefine).not.toHaveBeenCalled()
  })
  it('只读用户不可执行润色', () => {
    mount(true, true, true)
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('switch') as HTMLInputElement).disabled).toBe(true)
  })
})
