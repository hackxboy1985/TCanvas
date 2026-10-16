import { useEffect, useState } from 'react'
import { getLensCurrentUserIsAdmin } from '../api/lens'
import { isLensMode } from '../config/useModelOptions'
import { useAuth } from './store'

// 同一页面的多个节点共用一次身份查询；不使用开发环境“全员管理员”开关。
let lensAdminRequest: Promise<boolean> | undefined

/** JSON 调试入口仅向当前真实管理员展示，身份查询失败时不放行。 */
export function usePromptEditorAdmin(): boolean {
  const role = useAuth((state) => state.user?.role)
  const [lensAdmin, setLensAdmin] = useState(false)
  const lensMode = isLensMode()
  useEffect(() => {
    if (!lensMode) return
    let active = true
    lensAdminRequest ??= getLensCurrentUserIsAdmin()
    void lensAdminRequest.then((admin) => {
      if (active) setLensAdmin(admin)
    }).catch((error: unknown) => {
      console.error('[lens] 无法确认 JSON 编辑器管理员身份', error)
      if (active) setLensAdmin(false)
      lensAdminRequest = undefined
    })
    return () => { active = false }
  }, [lensMode])
  return lensMode ? lensAdmin : role === 'admin'
}
