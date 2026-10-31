import React from 'react'
import { create } from 'zustand'
import { Button, Group, Modal, Text } from '@mantine/core'
import './canvasConfirmDialog.css'

/** 画布确认弹窗参数 */
export type CanvasConfirmOptions = {
  /** 标题，默认「确认操作」 */
  title?: string
  /** 正文（覆盖/清空等风险说明） */
  message: string
  /** 确认按钮文案，默认「确定」 */
  confirmText?: string
  /** 取消按钮文案，默认「取消」 */
  cancelText?: string
  /** 是否危险操作：覆盖/删除类用红色确认按钮 */
  danger?: boolean
}

type PendingConfirm = CanvasConfirmOptions & { resolve: (confirmed: boolean) => void }

type CanvasConfirmState = { pending: PendingConfirm | null }

export const useCanvasConfirmStore = create<CanvasConfirmState>(() => ({ pending: null }))

/**
 * 画布内确认弹窗（Promise 版）。
 *
 * <p>为什么不用 window.confirm：原生弹窗是浏览器样式（浅色、系统字体、无主题），
 * 与画布暗色 Mantine 界面完全不搭；且原生 confirm 是同步阻塞，无法在确认前做异步校验。
 * 这里用 Mantine Modal + zustand 承载，返回 Promise<boolean>：确认=true、取消/关闭=false。</p>
 *
 * <p>使用前提：画布顶层已挂载 {@link CanvasConfirmDialogHost}（LensCanvasApp 已挂载）。</p>
 */
export function confirmCanvasAction(options: CanvasConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    useCanvasConfirmStore.setState({
      pending: {
        ...options,
        // 先关闭弹窗再 resolve：连续两次确认时，第二个弹窗不会被上一段残留状态吞掉
        resolve: (confirmed: boolean) => {
          useCanvasConfirmStore.setState({ pending: null })
          resolve(confirmed)
        },
      },
    })
  })
}

/**
 * 确认弹窗宿主：挂在画布顶层渲染一次即可。
 *
 * <p>样式走画布同一套 Mantine 主题（暗色），与资产库/任务结果等弹窗观感一致。</p>
 */
export function CanvasConfirmDialogHost(): JSX.Element | null {
  const pending = useCanvasConfirmStore((state) => state.pending)
  if (!pending) return null
  const {
    title = '确认操作',
    message,
    confirmText = '确定',
    cancelText = '取消',
    danger = false,
    resolve,
  } = pending

  return (
    <Modal
      className="canvas-confirm nodrag nopan nowheel"
      opened
      onClose={() => resolve(false)}
      centered
      size="min(420px, 92vw)"
      zIndex={4200}
      withCloseButton={false}
      closeOnClickOutside={false}
      overlayProps={{ backgroundOpacity: 0.55, blur: 2 }}
    >
      <div className="canvas-confirm__body">
        <Text className="canvas-confirm__title" size="sm" fw={600}>{title}</Text>
        <Text className="canvas-confirm__message" size="sm">{message}</Text>
        <Group className="canvas-confirm__actions" justify="flex-end" gap="xs">
          <Button className="canvas-confirm__cancel" variant="default" size="xs" radius="md" onClick={() => resolve(false)}>
            {cancelText}
          </Button>
          <Button
            className="canvas-confirm__ok"
            variant="filled"
            color={danger ? 'red' : 'blue'}
            size="xs"
            radius="md"
            onClick={() => resolve(true)}
          >
            {confirmText}
          </Button>
        </Group>
      </div>
    </Modal>
  )
}
