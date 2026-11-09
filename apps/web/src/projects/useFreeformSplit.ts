/**
 * 画布自由节点「拆分镜」hook（kind=text 自由文本节点 / 自由分镜脚本节点）。
 *
 * <p>与 {@link useLensScriptGeneration#splitShots}（lens 剧本/台本节点）的区别：
 * <ul>
 *   <li>不依赖 dramaId/episodeNum：把节点正文直接交给 {@code POST /api/canvas/splitShot}；</li>
 *   <li>结果<b>只落画布</b>：每镜一个 storyboardImage 节点 + 角色/场景/道具分组节点 + 连线，
 *       不写 lens 分镜表、不生成图片、不自动执行节点；</li>
 *   <li>拆分中按钮 loading、同步加锁禁止重复点击；失败给中文提示（含后端错误码）。</li>
 * </ul>
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import type { Edge, Node } from '@xyflow/react'
import { splitShotFreeform, lensErrorReason } from '../api/lens'
import { useRFStore } from '../canvas/store'
import { getNodeAbsPosition, getNodeSize } from '../canvas/utils/nodeBounds'
import { useUIStore } from '../ui/uiStore'
import { toast } from '../ui/toast'
import {
  buildFreeformSplitCanvasPlan,
  describeFreeformSplitPlan,
  resolveFreeformSplitNodePositions,
  type FreeformSplitCanvasPlan,
} from './freeformSplitNodes'

/** 拆分镜兜底时长（秒）：剧配置未给出 maxVideoDuration 时与后端默认值一致 */
const DEFAULT_SPLIT_VALUE_SECONDS = 15

/** 拆分镜能力（由 LensCanvasApp 实现并经 Canvas prop 注入节点工具栏） */
export interface FreeformSplitActions {
  /** 是否正在拆分（按钮 loading） */
  splitting: boolean
  /**
   * 拆分指定文本节点的正文，并在画布上生成分镜/资产自由节点。
   *
   * @param nodeId 被拆分的自由文本节点 id
   * @param content 该节点的纯文本正文
   */
  splitFreeform: (nodeId: string, content: string) => void
}

/** 生成节点相对来源节点的摆放起点（来源节点右侧，避开下方工具栏） */
function resolveSplitOrigin(anchorNodeId: string): { x: number; y: number } {
  const nodes = useRFStore.getState().nodes
  const nodesById = new Map(nodes.map((node) => [node.id, node] as const))
  const anchorNode = nodesById.get(anchorNodeId)
  if (!anchorNode) {
    return { x: 0, y: 0 }
  }
  const anchorPosition = getNodeAbsPosition(anchorNode, nodesById)
  const anchorSize = getNodeSize(anchorNode)
  return {
    x: anchorPosition.x + anchorSize.w + 120,
    y: anchorPosition.y,
  }
}

/**
 * 把生成计划转成 React Flow 节点与连线（补全真实 id、父子关系与绝对坐标）。
 *
 * @param plan   生成计划
 * @param origin 摆放起点
 * @returns 待写入画布的节点与连线
 */
function materializePlan(
  plan: FreeformSplitCanvasPlan,
  origin: { x: number; y: number },
): { nodes: Node[]; edges: Edge[] } {
  const positions = resolveFreeformSplitNodePositions(plan)
  // 每次拆分的 id 前缀唯一：同一来源节点多次拆分不会与上一次生成的节点 id 冲突
  const idPrefix = `freeform-split-${Date.now().toString(36)}-`
  const idByClientId = new Map<string, string>()
  for (const spec of plan.nodes) {
    idByClientId.set(spec.clientId, `${idPrefix}${spec.clientId}`)
  }
  const nodes: Node[] = plan.nodes.map((spec) => {
    const data = spec.data as { parentClientId?: string }
    const parentId = data.parentClientId ? idByClientId.get(data.parentClientId) : undefined
    const position = positions.get(spec.clientId) || spec.position
    return {
      id: String(idByClientId.get(spec.clientId)),
      type: spec.type,
      position: parentId ? position : { x: origin.x + position.x, y: origin.y + position.y },
      ...(parentId ? { parentId } : null),
      style: { width: spec.style.width, height: spec.style.height },
      data: spec.data,
    } as Node
  })
  const edges: Edge[] = plan.edges.map((edgeSpec) => ({
    id: `edge-freeform-split-${edgeSpec.sourceClientId}-${edgeSpec.targetClientId}`,
    source: String(idByClientId.get(edgeSpec.sourceClientId)),
    target: String(idByClientId.get(edgeSpec.targetClientId)),
    sourceHandle: edgeSpec.sourceHandle,
    targetHandle: edgeSpec.targetHandle,
    type: 'typed',
  })) as Edge[]
  return { nodes, edges }
}

/**
 * 自由节点拆分镜 hook。
 *
 * @returns 拆分状态与触发方法（引用稳定，供节点工具栏透传）
 */
export function useFreeformSplit(): FreeformSplitActions {
  const [splitting, setSplitting] = useState(false)
  /**
   * 同步动作锁：按钮 loading 要等下一次渲染才生效，连续点击的间隔内会被判成「未在运行」
   * 而重复拆分（会重复扣积分）。用 ref 同步加锁，保证一次只提交一个拆分请求。
   */
  const busyRef = useRef(false)

  const splitFreeform = useCallback((nodeId: string, content: string): void => {
    if (busyRef.current) return
    const text = String(content || '').trim()
    if (!text) {
      toast('节点正文为空，无法拆分镜', 'warning')
      return
    }
    busyRef.current = true
    setSplitting(true)
    void (async () => {
      try {
        // 每段时长取剧配置（与分镜板 maxVideoDuration 同源），未配置时用后端默认 15 秒
        const configuredDuration = Number(useUIStore.getState().lensProjectConfig?.maxVideoDuration)
        const splitValue = Number.isFinite(configuredDuration) && configuredDuration >= 1
          ? Math.trunc(configuredDuration)
          : DEFAULT_SPLIT_VALUE_SECONDS
        const result = await splitShotFreeform({ content: text, splitType: 'BY_DURATION', splitValue })
        const plan = buildFreeformSplitCanvasPlan(result.shots, {
          sourceNodeId: nodeId,
          origin: { x: 0, y: 0 },
        })
        const origin = resolveSplitOrigin(nodeId)
        const { nodes, edges } = materializePlan(plan, origin)
        const createdIds = useRFStore.getState().appendGraph(nodes, edges)
        if (createdIds.length === 0) {
          throw new Error('拆分镜结果未能写入画布（节点为空或与已有节点冲突）')
        }
        toast(describeFreeformSplitPlan(plan, result.chargedCredit), 'success')
      } catch (error) {
        // 后端错误码会拼在 msg 里（如「（错误码：ERR-xxx）」），直接展示便于用户反馈
        toast(`拆分镜失败：${lensErrorReason(error)}`, 'error')
      } finally {
        busyRef.current = false
        setSplitting(false)
      }
    })()
  }, [])

  return useMemo(() => ({ splitting, splitFreeform }), [splitting, splitFreeform])
}