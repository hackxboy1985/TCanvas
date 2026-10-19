import { Button, Group, Modal, SimpleGrid, Stack, Text, Textarea } from '@mantine/core'

/** 润色前后只读对比；关闭或取消不改动节点，只有采用才写入。 */
export function PromptPolishPreview(props: {
  opened: boolean
  before: string
  after: string
  onClose: () => void
  onAdopt?: () => void
}) {
  return (
    <Modal className="prompt-polish-preview" opened={props.opened} onClose={props.onClose} title="润色前后对比" size="xl" centered>
      <Stack className="prompt-polish-preview__body" gap="sm">
        <Text className="prompt-polish-preview__hint" size="sm">采用前不会修改原提示词；取消预览不会退回本次润色已发生的费用或免费次数。</Text>
        <SimpleGrid className="prompt-polish-preview__columns" cols={{ base: 1, sm: 2 }}>
          <Textarea className="prompt-polish-preview__before" label="润色前" value={props.before} readOnly autosize minRows={10} maxRows={20} />
          <Textarea className="prompt-polish-preview__after" label="润色后" value={props.after} readOnly autosize minRows={10} maxRows={20} />
        </SimpleGrid>
        <Group className="prompt-polish-preview__actions" justify="flex-end">
          <Button className="prompt-polish-preview__cancel" variant="default" onClick={props.onClose}>取消，保留当前提示词</Button>
          {props.onAdopt ? <Button className="prompt-polish-preview__adopt" onClick={props.onAdopt}>采用润色结果</Button> : null}
        </Group>
      </Stack>
    </Modal>
  )
}
