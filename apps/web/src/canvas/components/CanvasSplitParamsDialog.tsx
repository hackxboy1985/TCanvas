import React from 'react'
import { create } from 'zustand'
import { Button, Group, Modal, NumberInput, Radio, Text } from '@mantine/core'
import './canvasSplitParamsDialog.css'
import { $, $t } from '../i18n'

/** 拆分方式：按时长 / 按数量（与 lens 分镜板、后端 SplitType 枚举一致） */
export type CanvasSplitType = 'BY_DURATION' | 'BY_COUNT'

/** 拆分参数弹窗参数 */
export type CanvasSplitParamsOptions = {
  /** 弹窗标题，默认「拆分镜设置」 */
  title?: string
  /** 最大分镜时长（秒）：按时长拆分时的上限，取剧配置 maxVideoDuration，默认 15 */
  durationLimit?: number
  /** 默认拆分方式，默认按时长 */
  defaultSplitType?: CanvasSplitType
}

/** 拆分参数弹窗结果：confirmed=false 表示用户取消 */
export type CanvasSplitParamsResult = {
  confirmed: boolean
  splitType: CanvasSplitType
  splitValue: number
}

type PendingSplitParams = {
  options: {
    title: string
    durationLimit: number
    defaultSplitType: CanvasSplitType
  }
  resolve: (result: CanvasSplitParamsResult) => void
}

type CanvasSplitParamsState = { pending: PendingSplitParams | null }

export const useCanvasSplitParamsStore = create<CanvasSplitParamsState>(() => ({ pending: null }))

/** 默认最大分镜时长（秒）：与后端/分镜板默认值一致 */
const DEFAULT_DURATION_LIMIT = 15
/** 按数量拆分时的最大分镜数：与后端 SplitShotLogic 限制一致 */
const MAX_SPLIT_COUNT = 100
/** 按数量拆分时的默认分镜数 */
const DEFAULT_SPLIT_COUNT = 15

/**
 * 归一最大分镜时长：非法值回落 15 秒（与分镜板 ShotAgentPanel.durationLimit 同口径）。
 *
 * @param value 剧配置 maxVideoDuration
 * @returns 合法的最长单镜时长（秒）
 */
function normalizeDurationLimit(value: number | undefined): number {
  const limit = Number(value)
  return Number.isFinite(limit) && limit >= 1 ? Math.trunc(limit) : DEFAULT_DURATION_LIMIT
}

/**
 * 画布内拆分镜参数弹窗（Promise 版）。
 *
 * <p>用于画布「拆分镜」前让用户选择拆分方式（按时长/按数量）与参数（每段时长/总分镜数），
 * 与 lens 分镜板 ShotAgentPanel 的拆分设置保持一致；取消时 confirmed=false。</p>
 *
 * <p>使用前提：画布顶层已挂载 {@link CanvasSplitParamsDialogHost}（LensCanvasApp 已挂载）。</p>
 */
export function requestCanvasSplitParams(options?: CanvasSplitParamsOptions): Promise<CanvasSplitParamsResult> {
  return new Promise<CanvasSplitParamsResult>((resolve) => {
    useCanvasSplitParamsStore.setState({
      pending: {
        options: {
          title: options?.title || $('拆分镜设置'),
          durationLimit: normalizeDurationLimit(options?.durationLimit),
          defaultSplitType: options?.defaultSplitType || 'BY_DURATION',
        },
        // 先关闭弹窗再 resolve，避免下一次弹窗被残留状态吞掉
        resolve: (result: CanvasSplitParamsResult) => {
          useCanvasSplitParamsStore.setState({ pending: null })
          resolve(result)
        },
      },
    })
  })
}

/**
 * 拆分镜参数弹窗宿主：挂在画布顶层渲染一次即可。
 */
export function CanvasSplitParamsDialogHost(): JSX.Element | null {
  const pending = useCanvasSplitParamsStore((state) => state.pending)
  const [splitType, setSplitType] = React.useState<CanvasSplitType>('BY_DURATION')
  const [splitValue, setSplitValue] = React.useState<number>(DEFAULT_DURATION_LIMIT)

  React.useEffect(() => {
    if (!pending) return
    setSplitType(pending.options.defaultSplitType)
    setSplitValue(pending.options.defaultSplitType === 'BY_COUNT'
      ? DEFAULT_SPLIT_COUNT
      : pending.options.durationLimit)
  }, [pending])

  if (!pending) return null
  const { title, durationLimit } = pending.options
  const { resolve } = pending
  const maxValue = splitType === 'BY_DURATION' ? durationLimit : MAX_SPLIT_COUNT
  const effectiveValue = Number.isFinite(splitValue)
    ? Math.min(maxValue, Math.max(1, Math.trunc(splitValue)))
    : maxValue
  const hint = splitType === 'BY_DURATION'
    ? $t('建议 {{suggestMin}}-{{suggestMax}} 秒（最大 {{limit}} 秒）', {
      suggestMin: 10,
      suggestMax: Math.min(15, durationLimit),
      limit: durationLimit,
    })
    : $('建议 7-30 个（最多 100）')
  const finish = (confirmed: boolean): void => {
    resolve({ confirmed, splitType, splitValue: effectiveValue })
  }

  return (
    <Modal
      className="canvas-split-params nodrag nopan nowheel"
      opened
      onClose={() => finish(false)}
      centered
      size="min(440px, 92vw)"
      zIndex={4200}
      withCloseButton={false}
      closeOnClickOutside={false}
      overlayProps={{ backgroundOpacity: 0.55, blur: 2 }}
    >
      <div className="canvas-split-params__body">
        <Text className="canvas-split-params__title" size="sm" fw={600}>{title}</Text>
        <Radio.Group
          className="canvas-split-params__type"
          value={splitType}
          onChange={(value) => setSplitType(value === 'BY_COUNT' ? 'BY_COUNT' : 'BY_DURATION')}
          label={$('拆分方式')}
        >
          <Group className="canvas-split-params__type-options" gap="md" mt={8}>
            <Radio className="canvas-split-params__type-option" value="BY_DURATION" label={$('按时长')} />
            <Radio className="canvas-split-params__type-option" value="BY_COUNT" label={$('按数量')} />
          </Group>
        </Radio.Group>
        <NumberInput
          className="canvas-split-params__value"
          label={splitType === 'BY_DURATION' ? $('每段时长（秒）') : $('总分镜数')}
          value={effectiveValue}
          min={1}
          max={maxValue}
          step={1}
          description={hint}
          onChange={(value) => {
            const next = typeof value === 'number' ? value : Number(value)
            setSplitValue(Number.isFinite(next) ? next : effectiveValue)
          }}
        />
        <Group className="canvas-split-params__actions" justify="flex-end" gap="xs">
          <Button className="canvas-split-params__cancel" variant="default" size="xs" radius="md" onClick={() => finish(false)}>
            {$('取消')}
          </Button>
          <Button className="canvas-split-params__ok" variant="filled" size="xs" radius="md" onClick={() => finish(true)}>
            {$('开始拆分')}
          </Button>
        </Group>
      </div>
    </Modal>
  )
}
