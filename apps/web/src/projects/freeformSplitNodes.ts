/**
 * 画布自由节点「拆分镜」结果 → 自由画布节点（纯函数，无副作用）。
 *
 * <p>输入是 {@code /api/canvas/splitShot} 返回的逐镜明细，输出一批可直接写入 flow 的节点与连线：
 * <ul>
 *   <li>每镜一个 {@code kind=storyboardImage} 节点（label=分镜{i}，data.prompt=画面提示词，
 *       data.shotMeta 保留时长/台词等原镜头信息供编辑）；</li>
 *   <li>角色/场景/道具按名称去重后各建 {@code kind=image} 节点（label=名称），
 *       分别编入「角色」「场景」「道具」三个 groupNode 分组；</li>
 *   <li>资产节点 out-image → 分镜节点 in-image 连线（多个资产可连同一分镜）。</li>
 * </ul>
 *
 * <p>只产出画布编排数据，不写 lens 业务表、不生成图片、也不自动执行任何节点：
 * 生成图片仍需用户在画布上显式点击；资产节点只存名称，业务档案依旧只在 lens 业务表。</p>
 */
import type { Edge, Node } from '@xyflow/react'
import type { LensFreeformSplitShot } from '../api/lens'

/** 自由节点上记录拆分来源的标记：挂了这个标记的节点都是画布自由节点，不属于 lens 业务投影 */
export const FREEFORM_SPLIT_SOURCE = 'freeform_split'

/** 分组标签（同时作为资产节点分组名） */
export const FREEFORM_SPLIT_GROUP_LABELS = {
  character: '角色',
  scene: '场景',
  prop: '道具',
} as const

/** 分镜图节点尺寸（与画布 storyboardImage 节点默认尺寸一致） */
const SHOT_NODE_WIDTH = 420
const SHOT_NODE_HEIGHT = 300
/** 资产图节点尺寸（参考 lens 投影资产节点） */
const ASSET_NODE_WIDTH = 384
const ASSET_NODE_HEIGHT = 250
/** 分镜列横向间距 */
const SHOT_GAP_X = 80
/** 分镜自动换行时的每行列数（避免一次拆出很多分镜时无限变宽） */
const SHOT_COLUMNS = 4
/** 资产列（组）横向间距 */
const ASSET_GROUP_GAP_X = 80
/** 组内资产纵向间距 */
const ASSET_GAP_Y = 40
/** 组外框内边距 */
const GROUP_PADDING = 40
/** 组标题高度（组外框顶部留给标题的空间） */
const GROUP_TITLE_HEIGHT = 48
/** 组最小宽高 */
const GROUP_MIN_WIDTH = 320
const GROUP_MIN_HEIGHT = 200

/** 资产节点分类（与 lens 资产分类口径一致：1=角色、2=场景、3=道具） */
export type FreeformAssetCategory = 1 | 2 | 3

/** 生成的单个分镜节点（未带 id，落画布时补全） */
export interface FreeformSplitNodeSpec {
  /** 临时 clientId：连线与父子关系用它引用，落画布时映射成真实节点 id */
  clientId: string
  /** 节点类型（React Flow type） */
  type: 'taskNode' | 'groupNode'
  /** 节点业务种类（data.kind） */
  kind: 'storyboardImage' | 'image' | 'group'
  /** 节点标签 */
  label: string
  /** 节点数据（不含位置/父子关系） */
  data: Record<string, unknown>
  /** 期望的位置（写 flow 时使用） */
  position: { x: number; y: number }
  /** 期望尺寸 */
  style: { width: number; height: number }
}

/** 生成的连线（用临时 clientId 表达两端，落画布时再映射成真实节点 id） */
export interface FreeformSplitEdgeSpec {
  sourceClientId: string
  targetClientId: string
  sourceHandle: 'out-image'
  targetHandle: 'in-image'
}

/** 生成结果 */
export interface FreeformSplitCanvasPlan {
  nodes: FreeformSplitNodeSpec[]
  edges: FreeformSplitEdgeSpec[]
  /** 分镜节点数 */
  shotCount: number
  /** 角色/场景/道具节点数（去重后） */
  assetCount: number
}

/** 生成参数 */
export interface BuildFreeformSplitPlanOptions {
  /** 拆分来源文本节点的节点 id（用于记录来源与避免重名） */
  sourceNodeId: string
  /** 画布左上角起点（避开已有节点） */
  origin: { x: number; y: number }
}

/** 按名称去重且保序 */
function uniqueNames(names: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of names) {
    const name = String(raw || '').trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    result.push(name)
  }
  return result
}

/** 单镜的展示副标题：场景 / 机位 / 景别都有才展示，避免空串堆叠 */
function buildShotSubtitle(shot: LensFreeformSplitShot): string {
  return [shot.scene, shot.camera, shot.shotSize].map((part) => String(part || '').trim()).filter(Boolean).join(' · ')
}

/**
 * 把拆分结果转成画布节点与连线（纯函数）。
 *
 * <p>布局：左侧「角色 / 场景 / 道具」三列分组（资产区），右侧分镜区按网格横向排布。
 * 分镜与资产之间按「本镜出现的名称」建立连线：同一个资产可连多个分镜。</p>
 *
 * @param shots  拆分出的逐镜明细（后端返回顺序即分镜序号顺序）
 * @param options 来源节点与起点位置
 * @returns 待落画布的节点、连线与统计信息
 */
export function buildFreeformSplitCanvasPlan(
  shots: readonly LensFreeformSplitShot[],
  options: BuildFreeformSplitPlanOptions,
): FreeformSplitCanvasPlan {
  const { sourceNodeId, origin } = options
  const validShots = shots.filter((shot) => shot && Number.isFinite(Number(shot.index)))
  if (validShots.length === 0) {
    throw new Error('拆分结果为空，未生成任何节点')
  }

  // 1. 汇总资产名称（全局去重，保持出现顺序）
  const characterNames = uniqueNames(validShots.flatMap((shot) => shot.characters || []))
  const sceneNames = uniqueNames(validShots.flatMap((shot) => shot.sceneNames || []))
  const propNames = uniqueNames(validShots.flatMap((shot) => shot.propNames || []))

  const nodes: FreeformSplitNodeSpec[] = []
  const edges: FreeformSplitEdgeSpec[] = []
  /** 资产名称 → 节点 clientId（连线时使用） */
  const assetClientIdByKey = new Map<string, string>()

  const groups: Array<{ category: FreeformAssetCategory; label: string; names: string[] }> = [
    { category: 1, label: FREEFORM_SPLIT_GROUP_LABELS.character, names: characterNames },
    { category: 2, label: FREEFORM_SPLIT_GROUP_LABELS.scene, names: sceneNames },
    { category: 3, label: FREEFORM_SPLIT_GROUP_LABELS.prop, names: propNames },
  ]

  // 2. 资产区：每组一个 groupNode + 组内 image 节点
  let groupX = origin.x
  let assetMaxBottom = origin.y
  for (const group of groups) {
    // 没有对应资产时不建空分组
    if (group.names.length === 0) continue
    const groupInnerX = groupX + GROUP_PADDING
    const groupInnerY = origin.y + GROUP_TITLE_HEIGHT + GROUP_PADDING
    const groupContentWidth = ASSET_NODE_WIDTH
    const groupContentHeight = group.names.length * ASSET_NODE_HEIGHT + (group.names.length - 1) * ASSET_GAP_Y
    const groupWidth = Math.max(GROUP_MIN_WIDTH, groupContentWidth + GROUP_PADDING * 2)
    const groupHeight = Math.max(GROUP_MIN_HEIGHT, groupContentHeight + GROUP_TITLE_HEIGHT + GROUP_PADDING * 2)
    const groupClientId = `group-${group.category}`
    nodes.push({
      clientId: groupClientId,
      type: 'groupNode',
      kind: 'group',
      label: group.label,
      position: { x: groupX, y: origin.y },
      style: { width: groupWidth, height: groupHeight },
      data: {
        label: group.label,
        isGroup: true,
        source: FREEFORM_SPLIT_SOURCE,
        splitSourceNodeId: sourceNodeId,
        splitAssetCategory: group.category,
      },
    })

    group.names.forEach((name, index) => {
      const clientId = `asset-${group.category}-${index}`
      assetClientIdByKey.set(`${group.category}:${name}`, clientId)
      // 组内节点位置相对组外框（React Flow 子节点坐标是相对父节点的）
      nodes.push({
        clientId,
        type: 'taskNode',
        kind: 'image',
        label: name,
        position: { x: GROUP_PADDING, y: GROUP_TITLE_HEIGHT + GROUP_PADDING + index * (ASSET_NODE_HEIGHT + ASSET_GAP_Y) },
        style: { width: ASSET_NODE_WIDTH, height: ASSET_NODE_HEIGHT },
        data: {
          kind: 'image',
          label: name,
          prompt: name,
          source: FREEFORM_SPLIT_SOURCE,
          splitSourceNodeId: sourceNodeId,
          splitAssetCategory: group.category,
          parentClientId: groupClientId,
        },
      })
    })

    assetMaxBottom = Math.max(assetMaxBottom, origin.y + groupHeight)
    groupX += groupWidth + ASSET_GROUP_GAP_X
  }

  // 3. 分镜区：从资产区右侧开始，网格排布
  const shotAreaX = groupX
  const shotAreaY = origin.y
  validShots.forEach((shot, index) => {
    const clientId = `shot-${shot.index}`
    const col = index % SHOT_COLUMNS
    const row = Math.floor(index / SHOT_COLUMNS)
    const subtitle = buildShotSubtitle(shot)
    nodes.push({
      clientId,
      type: 'taskNode',
      kind: 'storyboardImage',
      label: `分镜${shot.index}`,
      position: {
        x: col * (SHOT_NODE_WIDTH + SHOT_GAP_X),
        y: row * (SHOT_NODE_HEIGHT + ASSET_GAP_Y),
      },
      style: { width: SHOT_NODE_WIDTH, height: SHOT_NODE_HEIGHT },
      data: {
        kind: 'storyboardImage',
        label: `分镜${shot.index}`,
        prompt: shot.prompt,
        ...(subtitle ? { subtitle } : null),
        source: FREEFORM_SPLIT_SOURCE,
        splitSourceNodeId: sourceNodeId,
        // 原镜头信息：时长/台词/机位/站位/动作/景别等，供用户改 prompt 时参考
        shotMeta: {
          index: shot.index,
          duration: shot.duration,
          scene: shot.scene,
          camera: shot.camera,
          blocking: shot.blocking,
          action: shot.action,
          shotSize: shot.shotSize,
          dialogue: shot.dialogue,
          characters: shot.characters,
          sceneNames: shot.sceneNames,
          propNames: shot.propNames,
          speakers: shot.speakers,
        },
        // 分镜区内的绝对位置在落画布时统一加上 shotAreaX/shotAreaY（见 resolveFreeformSplitNodePositions）
        splitAreaOffsetX: shotAreaX,
        splitAreaOffsetY: shotAreaY,
      },
    })

    // 4. 连线：本镜引用的资产 → 本镜分镜节点
    const refs: Array<[FreeformAssetCategory, string[]]> = [
      [1, shot.characters || []],
      [2, shot.sceneNames || []],
      [3, shot.propNames || []],
    ]
    const connected = new Set<string>()
    for (const [category, names] of refs) {
      for (const name of uniqueNames(names)) {
        const assetClientId = assetClientIdByKey.get(`${category}:${name}`)
        if (!assetClientId || connected.has(assetClientId)) continue
        connected.add(assetClientId)
        edges.push({
          sourceClientId: assetClientId,
          targetClientId: clientId,
          sourceHandle: 'out-image',
          targetHandle: 'in-image',
        })
      }
    }
  })

  return {
    nodes,
    edges,
    shotCount: validShots.length,
    assetCount: characterNames.length + sceneNames.length + propNames.length,
  }
}

/**
 * 计算生成节点的最终绝对位置（把分镜区偏移合并进分镜节点的网格坐标）。
 *
 * <p>资产节点与分组本身已是绝对坐标；组内资产节点保持相对父分组的坐标；
 * 分镜节点按网格相对排布，这里统一加上分镜区起点，避免与资产区重叠。</p>
 *
 * @param plan 生成结果
 * @returns 节点 clientId → 最终位置（组内子节点的坐标是相对父节点的）
 */
export function resolveFreeformSplitNodePositions(
  plan: FreeformSplitCanvasPlan,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>()
  for (const node of plan.nodes) {
    const data = node.data as { splitAreaOffsetX?: number; splitAreaOffsetY?: number; parentClientId?: string }
    if (node.kind === 'group' || data.parentClientId) {
      positions.set(node.clientId, node.position)
      continue
    }
    positions.set(node.clientId, {
      x: node.position.x + (data.splitAreaOffsetX || 0),
      y: node.position.y + (data.splitAreaOffsetY || 0),
    })
  }
  return positions
}

/** 一行汇总文案：给 toast 用 */
export function describeFreeformSplitPlan(plan: FreeformSplitCanvasPlan, chargedCredit: number): string {
  const creditText = chargedCredit > 0 ? `，消耗 ${chargedCredit} 积分` : ''
  const assetText = plan.assetCount > 0 ? `、${plan.assetCount} 个角色/场景/道具节点` : ''
  return `拆分镜完成：生成 ${plan.shotCount} 个分镜节点${assetText}，共 ${plan.edges.length} 条连线${creditText}`
}