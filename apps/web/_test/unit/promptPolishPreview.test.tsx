import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { PromptPolishPreview } from '../../src/canvas/nodes/taskNode/components/PromptPolishPreview'
import { PromptEditorActions } from '../../src/canvas/nodes/taskNode/components/PromptEditorActions'

describe('提示词润色预览与模式切换', () => {
  it('对比展示原文与结果；取消不采用，明确点击才采用', () => {
    const adopt = vi.fn()
    const close = vi.fn()
    render(<MantineProvider><PromptPolishPreview opened before="原始提示词" after="润色结果" onClose={close} onAdopt={adopt} /></MantineProvider>)
    expect(screen.getByDisplayValue('原始提示词')).toBeTruthy()
    expect(screen.getByDisplayValue('润色结果')).toBeTruthy()
    fireEvent.click(screen.getByText('取消，保留当前提示词'))
    expect(close).toHaveBeenCalledOnce()
    expect(adopt).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('采用润色结果'))
    expect(adopt).toHaveBeenCalledOnce()
    cleanup()
  })
  it('模式行恢复文字，不再放润色按钮', () => {
    render(<MantineProvider><PromptEditorActions isAdmin structured={false} hasStructuredPrompt loading={false} readOnly={false} onModeChange={() => undefined} /></MantineProvider>)
    expect(screen.getByText('提示词编辑模式')).toBeTruthy()
    expect(screen.queryByText('AI 润色')).toBeNull()
    cleanup()
  })
})
