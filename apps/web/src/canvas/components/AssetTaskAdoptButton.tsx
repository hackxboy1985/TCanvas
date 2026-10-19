import React from 'react'
import { Button, Group, Modal, Select, Stack, Text } from '@mantine/core'
import { IconCheck } from '@tabler/icons-react'
import { associateLensAssetTaskResult, type LensAssetTaskAdoptionTarget } from '../../api/lens'
import { syncLensAssetTaskImage } from '../utils/lensAssetTaskAdoption'
import { toast } from '../../ui/toast'

/** 对当前资产显式确认后关联任务原图；失败保留选择，不做本地假成功。 */
export function AssetTaskAdoptButton({ target, images }: { target: LensAssetTaskAdoptionTarget; images: string[] }) {
  const [opened, setOpened] = React.useState(false)
  const [selected, setSelected] = React.useState('0')
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState('')
  const savingRef = React.useRef(false)
  // 打开时固定目标和原图列表，防止轮询或切换资产改变待确认内容。
  const [draft, setDraft] = React.useState<{ target: LensAssetTaskAdoptionTarget; images: string[] } | null>(null)
  const confirm = async (): Promise<void> => {
    if (savingRef.current || !draft) return
    const url = draft.images[Number(selected)]
    if (!url) { setError('请选择要采纳的图片'); return }
    savingRef.current = true
    setSaving(true)
    setError('')
    try {
      await associateLensAssetTaskResult(draft.target, url)
      syncLensAssetTaskImage(draft.target, url)
      setOpened(false)
      toast('已关联到资产「' + draft.target.label + '」', 'success')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '采纳失败，请重试')
    } finally { savingRef.current = false; setSaving(false) }
  }
  return <>
    <Button className="lens-asset-task-panel__adopt" size="compact-xs" variant="filled" disabled={!images.length}
      leftSection={<IconCheck className="lens-asset-task-panel__adopt-icon" size={13} />}
      onClick={() => { setDraft({ target: { ...target }, images: [...images] }); setSelected('0'); setError(''); setOpened(true) }}>采纳结果</Button>
    <Modal className="lens-asset-task-adopt-modal" opened={opened} centered title="采纳结果"
      onClose={() => { if (!savingRef.current) setOpened(false) }} closeOnClickOutside={!saving} closeOnEscape={!saving} withCloseButton={!saving}>
      <Stack className="lens-asset-task-adopt-modal__body" gap="sm">
        <Text className="lens-asset-task-adopt-modal__help" size="sm">将所选图片关联到资产「{draft?.target.label}」，替换当前资产图片。原任务结果保留。</Text>
        {draft && draft.images.length > 1 && <Select className="lens-asset-task-adopt-modal__select" label="选择采纳图片" value={selected} allowDeselect={false}
          disabled={saving} data={draft.images.map((_, index) => ({ value: String(index), label: '结果 ' + (index + 1) }))}
          onChange={(value) => { if (value !== null) setSelected(value) }} />}
        {draft?.images[Number(selected)] && <img className="lens-asset-task-adopt-modal__preview" src={draft.images[Number(selected)]} alt="待采纳图片" />}
        {!!error && <Text className="lens-asset-task-adopt-modal__error" size="sm" c="red" role="alert">{error}</Text>}
        <Group className="lens-asset-task-adopt-modal__actions" justify="flex-end">
          <Button className="lens-asset-task-adopt-modal__cancel" variant="default" disabled={saving} onClick={() => setOpened(false)}>取消</Button>
          <Button className="lens-asset-task-adopt-modal__confirm" loading={saving} onClick={() => { void confirm() }}>确认采纳</Button>
        </Group>
      </Stack>
    </Modal>
  </>
}
