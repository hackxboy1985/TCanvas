import type { ReactNode } from 'react'
import { Group, Switch, Text, Tooltip } from '@mantine/core'

type PromptEditorActionsProps = {
  isAdmin: boolean
  structured: boolean
  hasStructuredPrompt: boolean
  loading: boolean
  readOnly: boolean
  /** 润色与撤销操作对所有用户展示，JSON 开关单独受管理员权限限制。 */
  actions?: ReactNode
  onModeChange: (structured: boolean) => void
}

/** 润色是显式 AI 操作；管理员 JSON 开关只负责本地展示切换。 */
export function PromptEditorActions(props: PromptEditorActionsProps) {
  return (
    <Group className="tc-task-node__prompt-actions" justify="space-between" gap={8}>
      <Text className="tc-task-node__prompt-mode-switch-label" size="xs">提示词编辑模式</Text>
      <Group className="tc-task-node__prompt-actions-right" gap={8}>
      {props.actions}
      {props.isAdmin ? (
        <Tooltip className="tc-task-node__prompt-json-help" label="仅切换展示，不调用 AI；请先润色以生成结构化内容">
          <Switch
            className="tc-task-node__prompt-mode-switch-input"
            size="xs"
            label="JSON"
            checked={props.structured}
            disabled={props.readOnly || props.loading || !props.hasStructuredPrompt}
            onChange={(event) => props.onModeChange(event.currentTarget.checked)}
          />
        </Tooltip>
      ) : null}
      </Group>
    </Group>
  )
}
