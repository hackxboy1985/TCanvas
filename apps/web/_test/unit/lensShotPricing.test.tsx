import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import LensShotNode from '../../src/canvas/nodes/LensShotNode'

vi.mock('../../src/config/useModelOptions', async (original) => {
  const actual = await original<typeof import('../../src/config/useModelOptions')>()
  const models = actual.toLensModelOptions([
    { value: '201', label: '视频模型甲', unitConsume: 10, resolutions: ['720p', '1080p'], creditPricing: { perSecond: true, cost: 10, resolutionPrices: { '720p': 10, '1080p': 23 } } },
    { value: '202', label: '视频模型乙', unitConsume: 7, resolutions: ['1080p'], creditPricing: { perSecond: true, cost: 7, resolutionPrices: { '1080p': 14 } } },
  ])
  return { ...actual, useModelOptions: () => models }
})
vi.mock('../../src/canvas/store', () => ({ useRFStore: { getState: () => ({ nodes: [], updateNodeData: vi.fn() }) } }))
const { openTaskResult, setCenter } = vi.hoisted(() => ({ openTaskResult: vi.fn(), setCenter: vi.fn() }))
vi.mock('../../src/canvas/CanvasRenderContext', () => ({ useCanvasRenderContext: () => ({ onOpenTaskResult: openTaskResult }) }))
vi.mock('../../src/api/lens', () => ({ editStoryboard: vi.fn().mockResolvedValue({}), clearStoryboardSpeaker: vi.fn(), submitShotVideo: vi.fn() }))
vi.mock('@xyflow/react', () => ({
  Handle: () => null, Position: { Bottom: 'bottom', Top: 'top', Left: 'left', Right: 'right' },
  NodeToolbar: ({ children }: { children: React.ReactNode }) => <div className="test-shot-toolbar">{children}</div>,
  useReactFlow: () => ({ getNode: () => ({ position: { x: 100, y: 200 }, width: 800, height: 450 }), setCenter }),
}))
vi.mock('@mantine/core', async (original) => ({
  ...await original<typeof import('@mantine/core')>(),
  // 只替换下拉框传输层；实际节点参数状态与积分展示逻辑保持原样。
  Select: ({ data, value, onChange, placeholder, 'aria-label': label }: { data: { value: string; label: string }[]; value?: string; onChange: (value: string) => void; placeholder?: string; 'aria-label'?: string }) => (
    <select className="test-shot-select" aria-label={label || placeholder} value={value || ''} onChange={(e) => onChange(e.target.value)}>
      {data.map((option) => <option className="test-shot-option" key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  ),
}))

afterEach(cleanup)
describe('分镜节点底部视频积分联动', () => {
  it.each(['doubleClick', 'play'] as const)('%s 当前分镜视频暂停同画布其他视频，保留当前视频和外部播放器', (event) => {
    const props = { id: 'shot-video', data: { selectedImageUrl: '/shot.mp4', selectFileType: 1 }, selected: false } as React.ComponentProps<typeof LensShotNode>
    const { container } = render(<MantineProvider><div className="react-flow"><video className="other-node-video" /><video className="paused-node-video" /><LensShotNode {...props} /></div><video className="outside-video" /></MantineProvider>)
    const current = container.querySelector<HTMLVideoElement>('.lens-shot-media')!
    const other = container.querySelector<HTMLVideoElement>('.other-node-video')!
    const paused = container.querySelector<HTMLVideoElement>('.paused-node-video')!
    const outside = container.querySelector<HTMLVideoElement>('.outside-video')!
    for (const video of [current, other, outside]) Object.defineProperty(video, 'paused', { configurable: true, value: false })
    other.currentTime = 12
    const currentPause = vi.spyOn(current, 'pause').mockImplementation(() => {})
    const otherPause = vi.spyOn(other, 'pause').mockImplementation(() => { fireEvent.pause(other) })
    const pausedPause = vi.spyOn(paused, 'pause').mockImplementation(() => {})
    const outsidePause = vi.spyOn(outside, 'pause').mockImplementation(() => {})
    fireEvent[event](current)
    expect(otherPause).toHaveBeenCalledTimes(1)
    expect(other.currentTime).toBe(12)
    expect(currentPause).not.toHaveBeenCalled()
    expect(pausedPause).not.toHaveBeenCalled()
    expect(outsidePause).not.toHaveBeenCalled()
  })
  it.each(['media', 'controls'] as const)('双击 %s 放大并播放暂停中的视频', (target) => {
    setCenter.mockClear()
    const props = { id: 'shot-video', data: { selectedImageUrl: '/shot.mp4', selectFileType: 1 }, selected: false } as React.ComponentProps<typeof LensShotNode>
    const { container } = render(<MantineProvider><div className="react-flow"><LensShotNode {...props} /></div></MantineProvider>)
    const video = container.querySelector<HTMLVideoElement>('.lens-shot-media')!
    let paused = true
    Object.defineProperty(video, 'paused', { configurable: true, get: () => paused })
    const play = vi.spyOn(video, 'play').mockImplementation(() => { paused = false; fireEvent.play(video); return Promise.resolve() })
    vi.spyOn(video, 'pause').mockImplementation(() => { paused = true; fireEvent.pause(video) })
    const element = target === 'media' ? video : container.querySelector<HTMLElement>('.lens-shot-video-controls')!
    // 浏览器双击先发送两次 click，必须在最后的 dblclick 明确恢复播放。
    if (target === 'media') { fireEvent.click(video, { detail: 1 }); fireEvent.click(video, { detail: 2 }) }
    fireEvent.doubleClick(element)
    expect(play).toHaveBeenCalled()
    expect(video.paused).toBe(false)
    expect(setCenter).toHaveBeenCalledWith(500, 425, { zoom: 1.2, duration: 250 })
  })
  it('选中节点时工具栏不滚动，长提示词留在固定行数编辑框中', () => {
    const props = { id: 'shot-scroll', data: { prompt: '长提示词'.repeat(100), scriptContent: '短剧本' }, selected: true } as React.ComponentProps<typeof LensShotNode>
    const { container } = render(<MantineProvider><LensShotNode {...props} /></MantineProvider>)
    const frame = container.querySelector<HTMLElement>('.test-shot-toolbar .tc-task-node__toolbar-frame')
    const editor = container.querySelector<HTMLTextAreaElement>('.lens-shot-prompt-editor textarea')
    expect(frame?.style.overflow).toBe('visible')
    expect(frame?.style.maxHeight).toBe('')
    expect(editor?.rows).toBe(7)
    expect(editor?.value).toBe('长提示词'.repeat(100))
    fireEvent.click(screen.getByLabelText('提示词'))
    expect(editor?.value).toBe('短剧本')
    expect(frame?.style.overflow).toBe('visible')
    fireEvent.click(screen.getByLabelText('提示词'))
    expect(editor?.value).toBe('长提示词'.repeat(100))
    expect(frame?.style.overflow).toBe('visible')
  })
  it('工具栏任务结果入口复用当前分镜的抽屉回调', () => {
    openTaskResult.mockClear()
    const props = { id: 'shot-42', data: { model: '201', time: 5 }, selected: true } as React.ComponentProps<typeof LensShotNode>
    const { container } = render(<MantineProvider><LensShotNode {...props} /></MantineProvider>)
    const button = container.querySelector<HTMLButtonElement>('.lens-shot-task-results')
    expect(button?.textContent).toBe('任务结果')
    fireEvent.click(button!)
    expect(openTaskResult).toHaveBeenCalledTimes(1)
    expect(openTaskResult).toHaveBeenCalledWith('shot-42')
  })
  it('切分辨率、生成秒数、模型后更新实际显示的总积分', () => {
    const props = { id: 'shot-1', data: { model: '201', resolution: '720p', time: 5 }, selected: true } as React.ComponentProps<typeof LensShotNode>
    render(<MantineProvider><LensShotNode {...props} /></MantineProvider>)
    expect(screen.getByText('50 积分')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('分辨率'), { target: { value: '1080p' } })
    expect(screen.getByText('115 积分')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('生成时长'), { target: { value: '10' } })
    expect(screen.getByText('230 积分')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('选择生视频模型'), { target: { value: '202' } })
    expect(screen.getByText('140 积分')).toBeTruthy()
  })
})
