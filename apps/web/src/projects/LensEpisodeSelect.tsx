import { Select } from '@mantine/core'
import { $ } from '../canvas/i18n'

interface LensEpisodeSelectProps {
  episodeNum: number
  options: Array<{ value: string; label: string }>
  onChange: (episodeNum: number) => void
}

/** 画布选集：使用接口返回的真实集号，重复选择当前集不代表清空或切集。 */
export function LensEpisodeSelect({ episodeNum, options, onChange }: LensEpisodeSelectProps) {
  return (
    <Select
      className="lens-canvas-episode-select"
      size="xs"
      placeholder={$('选集')}
      value={String(episodeNum)}
      // Mantine 默认允许反选并返回 null；Number(null) 会变成不存在的第 0 集。
      allowDeselect={false}
      onChange={(value) => {
        if (value === null || value.trim() === '') return
        const next = Number(value)
        // 集号是业务正整数，不是选项数组下标；当前集无需触发保存和加载。
        if (Number.isInteger(next) && next > 0 && next !== episodeNum) onChange(next)
      }}
      data={options}
      w={180}
    />
  )
}
