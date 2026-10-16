import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ lensMode: true, role: 'user', admin: vi.fn() }))
vi.mock('../../src/api/lens', () => ({ getLensCurrentUserIsAdmin: mocks.admin }))
vi.mock('../../src/config/useModelOptions', () => ({ isLensMode: () => mocks.lensMode }))
vi.mock('../../src/auth/store', () => ({ useAuth: (selector: (state: { user: { role: string } }) => unknown) => selector({ user: { role: mocks.role } }) }))
import { usePromptEditorAdmin } from '../../src/auth/usePromptEditorAdmin'

describe('JSON 编辑器真实管理员权限', () => {
  it('lens 节点共用后端身份查询，不信任 TapCanvas 角色', async () => {
    mocks.admin.mockResolvedValue(true)
    const first = renderHook(usePromptEditorAdmin)
    const second = renderHook(usePromptEditorAdmin)
    await waitFor(() => expect(first.result.current).toBe(true))
    expect(second.result.current).toBe(true)
    expect(mocks.admin).toHaveBeenCalledTimes(1)
    first.unmount()
    second.unmount()
  })
  it('非 lens 普通用户不开放 JSON，管理员开放', () => {
    mocks.lensMode = false
    const hook = renderHook(usePromptEditorAdmin)
    expect(hook.result.current).toBe(false)
    mocks.role = 'admin'
    hook.rerender()
    expect(hook.result.current).toBe(true)
    hook.unmount()
  })
})
