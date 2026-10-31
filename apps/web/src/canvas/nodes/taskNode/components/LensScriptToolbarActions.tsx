import React from 'react'
import { Button, Tooltip } from '@mantine/core'
import { IconDeviceFloppy, IconScissors, IconScript } from '@tabler/icons-react'
import type { LensScriptGenerationActions, LensScriptTextKind } from '../../../CanvasRenderContext'

type LensScriptToolbarActionsProps = {
  /** 宿主注入的生成/保存能力（接口调用/轮询/刷新/保存都在 LensCanvasApp 完成） */
  generation: LensScriptGenerationActions
  /** 与文本工具栏其它分隔线保持一致的颜色 */
  dividerColor: string
  /** 当前节点业务类型：剧本=原文，台本=script_content（决定保存到哪张字段、是否展示生台本） */
  scriptNodeType: LensScriptTextKind
  /** 当前节点的纯文本内容（保存按钮使用；编辑时已实时同步到节点数据） */
  scriptText: string
}

/**
 * 剧本/台本节点顶部工具栏的「生台本 / 拆分镜 / 保存」按钮。
 *
 * <p>这里只负责触发：真正的接口调用、结果轮询、完成后画布刷新与正文保存，
 * 由 LensCanvasApp 的 useLensScriptGeneration 统一处理，节点不直接调 lens 接口，
 * 避免同一套业务编排在节点里再实现一份。</p>
 *
 * <p>按钮差异：『生台本』只在剧本节点展示（在台本节点上再点语义重复）；
 * 『拆分镜』与『保存』两种节点都展示。</p>
 */
export function LensScriptToolbarActions({
  generation,
  dividerColor,
  scriptNodeType,
  scriptText,
}: LensScriptToolbarActionsProps): JSX.Element {
  const { scriptRunning, splitRunning, saveRunning, scriptGenEnabled, hasScript, generateScript, splitShots, saveScriptText } = generation
  /** 任一任务/保存进行中时按钮互斥，避免同时提交任务或并发写库 */
  const busy = scriptRunning || splitRunning || saveRunning
  // 剧本节点才展示生台本；剧配置明确关闭台本功能时也不展示（与分镜板隐藏台本入口的口径一致），
  // 尚未查到（null）时照常展示，点击后宿主会再查一次并给出「未开启」的明确提示。
  const canGenerateScript = scriptNodeType === '剧本' && scriptGenEnabled !== false

  return (
    <>
      <div className="tc-task-node__text-inline-divider" style={{ width: 1, height: 20, background: dividerColor }} />
      {canGenerateScript && (
        <Tooltip
          label={hasScript ? '根据本集剧本原文重新生成台本（覆盖现有台本）' : '根据本集剧本原文生成台本'}
          position="bottom"
          withArrow
        >
          <Button
            className="tc-task-node__lens-script-action"
            variant="light"
            size="compact-xs"
            radius="xl"
            loading={scriptRunning}
            disabled={busy && !scriptRunning}
            leftSection={<IconScript size={13} />}
            onClick={generateScript}
          >
            生台本
          </Button>
        </Tooltip>
      )}
      <Tooltip
        label="按本集台本（无台本时用剧本原文）拆分镜，结果自动保存到分镜表"
        position="bottom"
        withArrow
      >
        <Button
          className="tc-task-node__lens-script-action"
          variant="light"
          size="compact-xs"
          radius="xl"
          loading={splitRunning}
          disabled={busy && !splitRunning}
          leftSection={<IconScissors size={13} />}
          onClick={splitShots}
        >
          拆分镜
        </Button>
      </Tooltip>
      <Tooltip
        label={scriptNodeType === '台本' ? '保存台本到本集业务表（script_content）' : '保存剧本原文到本集业务表（content）'}
        position="bottom"
        withArrow
      >
        <Button
          className="tc-task-node__lens-script-action"
          variant="default"
          size="compact-xs"
          radius="xl"
          loading={saveRunning}
          disabled={busy && !saveRunning}
          leftSection={<IconDeviceFloppy size={13} />}
          onClick={() => saveScriptText(scriptNodeType, scriptText)}
        >
          保存
        </Button>
      </Tooltip>
    </>
  )
}
