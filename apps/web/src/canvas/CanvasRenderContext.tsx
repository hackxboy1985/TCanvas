import React from 'react'
import type { FreeformSplitActions } from '../projects/useFreeformSplit'

/** 自由文本节点「拆分镜」能力（统一从此模块导出，避免各处重复引 hook 模块） */
export type { FreeformSplitActions }

/** 剧本类文本节点的业务类型：剧本=原文（novel_episode.content），台本=script_content */
export type LensScriptTextKind = '剧本' | '台本'

/**
 * 剧本节点顶部工具栏可用的 lens 生成能力（生台本 / 拆分镜 / 保存正文）。
 *
 * <p>由 LensCanvasApp 实现并通过 Canvas prop 注入：接口调用、轮询、完成后画布刷新、
 * 正文保存都在宿主完成，节点内部只负责渲染按钮和触发，避免节点直接耦合 lens 业务编排。
 * 非 lens 宿主（未注入）时节点不显示这些按钮。</p>
 */
export type LensScriptGenerationActions = {
  /** 台本生成任务进行中 */
  scriptRunning: boolean
  /** 拆分镜任务进行中 */
  splitRunning: boolean
  /** 剧本/台本正文保存中 */
  saveRunning: boolean
  /** 剧配置是否开启台本功能；null=尚未查询到 */
  scriptGenEnabled: boolean | null
  /** 本集是否已有台本 */
  hasScript: boolean
  /** 提交台本生成任务 */
  generateScript: () => void
  /** 提交拆分镜任务 */
  splitShots: () => void
  /**
   * 保存剧本/台本正文到 lens 业务表。
   *
   * <p>kind=剧本 → novel_episode.content；kind=台本 → novel_episode.script_content。
   * 画布 flow 不保存正文，这里保存成功才算真正生效。</p>
   */
  saveScriptText: (kind: LensScriptTextKind, content: string) => void
}

export type CanvasRenderContextValue = {
  heavySelectionActive: boolean
  heavySelectionDragging: boolean
  selectedNodeCount: number
  /**
   * 打开「任务结果」抽屉（只读展示该节点的历史生成结果）。
   *
   * <p>由 LensCanvasApp 注入：抽屉需在画布顶层渲染，节点内部只负责触发。
   * 非 lens 宿主（未注入）时为 undefined，节点上的入口按钮不显示。
   */
  onOpenTaskResult?: (nodeId: string) => void
  /**
   * 剧本节点「生台本 / 拆分镜」能力（lens 画布注入）。
   *
   * <p>与 {@link onOpenTaskResult} 同理：必须由 Canvas 内部 Provider 透传，
   * 外部再包一层 Provider 会被覆盖，节点侧拿不到。</p>
   */
  lensScriptGeneration?: LensScriptGenerationActions
  /**
   * 画布自由文本节点「拆分镜」能力（lens 画布注入）。
   *
   * <p>只对自由节点（kind=text）生效：正文直接送 POST /api/canvas/splitShot，
   * 结果落成画布自由节点（分镜节点 + 角色/场景/道具分组 + 连线），不写 lens 业务表。
   * 带 dramaId 的 lens 剧本/台本节点仍走 {@link lensScriptGeneration} 的原链路。</p>
   */
  freeformSplit?: FreeformSplitActions
}

const DEFAULT_CANVAS_RENDER_CONTEXT: CanvasRenderContextValue = {
  heavySelectionActive: false,
  heavySelectionDragging: false,
  selectedNodeCount: 0,
}

export const CanvasRenderContext = React.createContext<CanvasRenderContextValue>(
  DEFAULT_CANVAS_RENDER_CONTEXT,
)

export function useCanvasRenderContext(): CanvasRenderContextValue {
  return React.useContext(CanvasRenderContext)
}