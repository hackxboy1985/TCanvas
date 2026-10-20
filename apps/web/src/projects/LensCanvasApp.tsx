/**
 * Lens 画布入口（lens 模式）
 *
 * - 读 URL query 参数：dramaId、episode
 * - 顶部选集下拉（调 lens 现有接口 listEpisodes）
 * - 数据加载：listStoryboards + getEpisodeAssets + getScriptContent → 投影节点（引用模式）
 * - 编排持久化：getFlow 恢复 / saveFlow 保存（debounce 3s + 切集自动保存）
 * - 复用画布核心 Canvas + store（拖拽/连线/子图/节点编辑框都是 tapCanvas 原生）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Edge, Node } from '@xyflow/react'
import { Button, Group, Select, Switch, Text, LoadingOverlay, Alert } from '@mantine/core'
import Canvas from '../canvas/Canvas'
import PreviewModal from '../ui/PreviewModal'
import type { CanvasHandle } from '../canvas/Canvas'
import { useRFStore } from '../canvas/store'
import { buildShotRefsFromAssets } from '../canvas/nodes/LensShotNode'
import {
  listEpisodes,
  listStoryboards,
  getEpisodeAssets,
  getScriptContent,
  getFlow,
  saveFlow,
  type LensEpisodeBrief,
  type LensStoryboard,
  type LensAssetEnriched,
  canViewTaskParams,
  type LensScriptContent,
} from '../api/lens'
import { getLensCanvasFlowId, readCanvasNodeAssetId, setLensCanvasFlowId } from '../canvas/utils/canvasNodeAssetId'
import { TaskResultDrawer, type TaskResultAdoptedPayload, type TaskResultTarget } from '../canvas/components/TaskResultDrawer'
import { toast } from '../ui/toast'
import { LENS_ASSET_MEDIA_HEIGHT, LENS_ASSET_NODE_WIDTH } from './lensCanvasNodeLayout'

/** 读取 URL query 参数 */
function readQueryParams(): { dramaId: string; episode: number } {
  const params = new URLSearchParams(window.location.search)
  const dramaId = String(params.get('dramaId') || '').trim()
  const episodeRaw = Number(params.get('episode') || 1)
  const episode = Number.isFinite(episodeRaw) && episodeRaw > 0 ? Math.trunc(episodeRaw) : 1
  return { dramaId, episode }
}

/**
 * 默认投影布局版本：布局规则变化时 +1。
 * 恢复 flow 时若版本不一致，节点位置改用最新投影布局（用户手动拖过的位置随布局版本重置）。
 *
 * v5：资产布局改为「父级 + 其子级（分身/子场景）成组」排列，子级排在父级下一排/下一列，
 *     旧版本 flow 的资产位置不再适用，需按新布局重投影。
 */
const LAYOUT_VERSION = 5

/** 预加载分镜媒体宽高比：图片用 Image，视频用隐藏 video 的 metadata；失败/无媒体返回 null */
async function loadShotAspects(storyboards: LensStoryboard[]): Promise<Map<string, number | null>> {
  const aspects = new Map<string, number | null>()
  const jobs = storyboards.map((shot) => {
    const url = String(shot.selectedImageUrl ?? '').trim()
    if (!url) {
      aspects.set(String(shot.id), null)
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      const done = () => resolve()
      const timer = window.setTimeout(() => {
        // 超时：媒体存在但比例未知 → 保守高度（-1）
        aspects.set(String(shot.id), -1)
        done()
      }, 3000)
      if (shot.selectFileType === 1) {
        // 视频：隐藏 video（挂到 DOM 确保 loadedmetadata 触发）读 metadata
        const v = document.createElement('video')
        v.preload = 'metadata'
        v.muted = true
        v.style.display = 'none'
        document.body.appendChild(v)
        const cleanup = () => { document.body.removeChild(v) }
        v.onloadedmetadata = () => {
          window.clearTimeout(timer)
          aspects.set(String(shot.id), v.videoWidth > 0 && v.videoHeight > 0 ? v.videoWidth / v.videoHeight : -1)
          cleanup()
          done()
        }
        v.onerror = () => {
          window.clearTimeout(timer)
          aspects.set(String(shot.id), -1)
          cleanup()
          done()
        }
        v.src = url
      } else {
        // 图片
        const img = new Image()
        img.onload = () => {
          window.clearTimeout(timer)
          aspects.set(String(shot.id), img.naturalWidth > 0 && img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : -1)
          done()
        }
        img.onerror = () => {
          window.clearTimeout(timer)
          aspects.set(String(shot.id), -1)
          done()
        }
        img.src = url
      }
    })
  })
  await Promise.all(jobs)
  return aspects
}

/** 整理布局常量 */
const ARRANGE_START = 40
const ARRANGE_GAP = 40
const ARRANGE_SECTION_GAP = 120

/**
 * 投影资产节点（角色/场景/道具）的尺寸见 ./lensCanvasNodeLayout。
 *
 * `data.nodeHeight` 的语义是**图片内容高度**：TaskNode 会把它同时用于图片容器高度，
 * 且渲染标题栏（投影节点恒定渲染，展示角色名 + 类型标签）时外壳由内容自然撑开，
 * 实际总高 = 图片高度 + 标题栏高度。因此只传图片高度，不能把标题栏再算进来，
 * 否则图片容器与外壳各算一次标题栏、会导致底部溢出组框。
 */

/**
 * 顶部栏占位高度（仅用于估算节点总高与行距）。
 * 投影节点以 showMeta/showIcon/showStatus=false 渲染 TaskNodeHeader 紧凑模式，
 * 只显示「角色名 + 类型标签」两行文字（无图标）：标题 ~17 + 副标题 ~14 + marginBottom 12 ≈ 43，取 44。
 */
const LENS_ASSET_HEADER_HEIGHT = 44
/** 节点实际总高（图片区 + 顶部栏），用于行距估算 */
const LENS_ASSET_NODE_HEIGHT = LENS_ASSET_MEDIA_HEIGHT + LENS_ASSET_HEADER_HEIGHT

/**
 * 父子分组（分身/子场景）组框顶部的可拖拽带高度。
 *
 * 子节点在组内固定不可拖拽，若其标题栏紧贴组框顶部，用户会把子节点标题误认成组框标题
 * 并尝试拖动，却命中子节点而拖不动。因此在组框顶部留出该高度的空白，使组框顶部始终可拖。
 */
const CHILD_GROUP_DRAG_BAND = 40

/** 节点布局尺寸（优先 React Flow 测量值） */
function arrangeNodeSize(n: Node): { w: number; h: number } {
  return {
    w: Number(n.measured?.width ?? n.width ?? 400),
    h: Number(n.measured?.height ?? n.height ?? 300),
  }
}

/** lens 剧本/台本文本节点 */
function isLensScriptNode(n: Node): boolean {
  return n.type === 'taskNode'
    && String((n.data as { kind?: string })?.kind) === 'text'
    && (n.data as { source?: string })?.source === 'lens_projection'
}

/** lens 资产节点（角色/场景/道具，带 assetCategory） */
function isLensAssetNode(n: Node): boolean {
  return n.type === 'taskNode' && typeof (n.data as { assetCategory?: number })?.assetCategory === 'number'
}

/**
 * 是否为 lens 投影节点（业务字段权威在 lens 业务表，flow 只存编排）。
 *
 * 判定依据（双条件，缺一不可）：
 * - lensShot 分镜节点：类型本身即身份，历史数据不带 source 标记
 * - 其余投影节点（角色/场景/道具/剧本/台本）：带 source='lens_projection'
 *
 * 自由节点（用户手动创建的任务节点）没有 lens 实体身份，返回 false，其任务参数需完整保留。
 */
function isLensProjectionNode(n: Node): boolean {
  if (n.type === 'lensShot') return true
  return (n.data as { source?: string })?.source === 'lens_projection'
}

/**
 * 投影节点存入 flow 时保留的编排字段白名单。
 *
 * 业务字段（prompt/imageUrl/scriptContent/selectedImageUrl/refs/roleName 等）
 * 一律不存：它们由 lens 接口在每次打开画布时重新投影覆盖，存入 flow 既冗余，
 * 又会在实体被删除/重新拆分后变成污染源。
 *
 * roleCardId 必须保留：投影不产生该字段，重开画布时不会被投影覆盖，
 * 而 resolveSemanticNodeAnchorBindings 会由它重建 anchorBindings 的 refId
 * （见 buildLegacyCharacterAnchorBindings）。若剔除，用户手动绑定的角色卡会丢失。
 *
 * anchorBindings 不保留：它由投影在每次打开画布时重建，且其 imageUrl/entityId/label
 * 与 data 顶层字段重复。手动绑卡信息改由 roleCardId 承载，可跨会话保留。
 */
const PROJECTION_KEPT_DATA_KEYS = [
  'kind',
  'label',
  'entityId',
  'sourceProjectId',
  'source',
  'showRefs',
  'hidden',
  'assetCategory',
  'lensTypeLabel',
  'nodeWidth',
  'nodeHeight',
  'roleCardId',
] as const

/**
 * 运行期状态字段：每次运行/轮询都会变化，不属于编排数据，一律不写入 flow。
 *
 * - status/progress/canceled/lastError：任务执行状态，由业务表与轮询重建
 * - runToken：每次执行生成的随机令牌，仅用于本次运行的取消判定，跨会话无意义
 * - logs：运行日志，体积随运行次数无上限增长，不属于编排数据
 */
const RUNTIME_ONLY_DATA_KEYS = [
  'status',
  'progress',
  'canceled',
  'lastError',
  'runToken',
  'logs',
] as const

/** 剔除运行期状态字段（返回新对象，不修改入参） */
function stripRuntimeFields(data: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = { ...data }
  for (const key of RUNTIME_ONLY_DATA_KEYS) {
    delete cleaned[key]
  }
  return cleaned
}

/**
 * 序列化单个节点：投影节点只留编排字段，自由节点保留任务参数但统一清洗运行期状态。
 *
 * 投影节点走「白名单保留」，因此即使节点是从旧 flow（改动前保存、含 anchorBindings
 * 等冗余字段）加载进来的，再次保存时也会被清除，无需数据迁移即可自愈。
 */
function serializeNodeForFlow(n: Node): Node {
  const base = {
    id: n.id,
    type: n.type,
    position: n.position,
    ...(n.parentId ? { parentId: n.parentId } : {}),
    ...(typeof n.width === 'number' ? { width: n.width } : {}),
    ...(typeof n.height === 'number' ? { height: n.height } : {}),
    ...(typeof n.draggable === 'boolean' ? { draggable: n.draggable } : {}),
  }
  const data = (n.data || {}) as Record<string, unknown>
  if (isLensProjectionNode(n)) {
    const kept: Record<string, unknown> = {}
    for (const key of PROJECTION_KEPT_DATA_KEYS) {
      if (key in data) kept[key] = data[key]
    }
    return { ...base, data: kept } as Node
  }
  // 自由节点：保留任务参数（taskId/模型/prompt 等），仅清洗运行期状态
  return { ...base, data: stripRuntimeFields(data) } as Node
}

/** 序列化整张画布：供 flow 持久化使用，剔除可从 lens 接口重新投影的业务字段 */
function serializeNodesForFlow(nodes: Node[]): Node[] {
  return nodes.map(serializeNodeForFlow)
}

/** 分镜组基准位置：垂直→图片右侧、水平→剧本列右侧且在图片下方（与组关闭时的分镜区域一致） */
function computeShotAreaOrigin(nodes: Node[], direction: 'column' | 'flow'): { x: number; y: number } {
  const scripts = nodes.filter(isLensScriptNode)
  const assets = nodes.filter(isLensAssetNode)
  let scriptsRight = 0
  scripts.forEach((n) => { scriptsRight = Math.max(scriptsRight, n.position.x + arrangeNodeSize(n).w) })
  const contentX = scripts.length > 0 ? scriptsRight + ARRANGE_SECTION_GAP : ARRANGE_START
  if (direction === 'column') {
    let assetsRight = contentX - ARRANGE_SECTION_GAP
    let maxAssetWidth = 0
    assets.forEach((n) => {
      const size = arrangeNodeSize(n)
      assetsRight = Math.max(assetsRight, n.position.x + size.w)
      maxAssetWidth = Math.max(maxAssetWidth, size.w)
    })
    // 垂直排列：分镜与图片之间空出一个图片宽度
    const gapByImage = maxAssetWidth || 480
    return { x: assetsRight + gapByImage + ARRANGE_SECTION_GAP, y: ARRANGE_START }
  }
  let assetsBottom = ARRANGE_START
  let maxAssetWidth = 0
  assets.forEach((n) => {
    const size = arrangeNodeSize(n)
    assetsBottom = Math.max(assetsBottom, n.position.y + size.h)
    maxAssetWidth = Math.max(maxAssetWidth, size.w)
  })
  // 水平排列：分镜与图片之间同样空出一个图片宽度（上下方向）
  const gapByImage = maxAssetWidth || 480
  return { x: contentX, y: assetsBottom + gapByImage + ARRANGE_SECTION_GAP }
}

/** 预估单个分镜节点高度（媒体按 800 宽/竖屏 720 高 + 顶部栏 + 引用行） */
function estimateShotNodeHeight(mediaAspect: number | null, showRefs: boolean): number {
  const HEADER = 30
  const REFS = showRefs ? 38 : 0
  let mediaHeight = 450
  if (mediaAspect === -1) {
    // 有媒体但比例未知：保守按竖屏最大高度 720，避免预估过矮导致节点叠加
    mediaHeight = 720
  } else if (mediaAspect && mediaAspect > 0) {
    mediaHeight = mediaAspect >= 1 ? Math.round(800 / mediaAspect) : Math.min(720, Math.round(800 / mediaAspect))
  }
  return mediaHeight + HEADER + REFS
}

/** 把 lens 数据投影成 React Flow 节点与引用连线（引用模式：节点只存 entityId，展示字段为投影快照） */
function buildCanvasNodes(input: {
  storyboards: LensStoryboard[]
  assets: LensAssetEnriched[]
  script: LensScriptContent
  dramaId: string
  /** 分镜 id → 预估媒体宽高比（用于纵向布局按上一节点高度累计，防叠加） */
  shotAspects?: Map<string, number | null>
  /** 是否显示引用行（影响节点高度） */
  showRefs?: boolean
}): { nodes: Node[]; edges: Edge[] } {
  const { storyboards, assets, script, dramaId, shotAspects, showRefs } = input
  const nodes: Node[] = []
  const edges: Edge[] = []
  // 资产节点 id 映射：category:id → 画布节点 id（分镜引用连线用）
  const assetNodeIdByKey = new Map<string, string>()
  const addNode = (id: string, kind: string, label: string, position: { x: number; y: number }, data: Record<string, unknown>, type: string = 'taskNode') => {
    nodes.push({
      id,
      type,
      position,
      data: { kind, label, entityId: id, sourceProjectId: dramaId, ...data },
    })
  }
  const rememberAssetNode = (category: number, assetId: string, nodeId: string) => {
    if (category && assetId) assetNodeIdByKey.set(`${category}:${assetId}`, nodeId)
  }

  // 1. 资产节点（角色/场景/道具），从 assetsByEpisode 去重 assetId
  // 默认布局：第 1 列角色；第 2 列场景（在前）+ 道具（在后），首个场景与首个角色同高
  const COL1_X = 40
  const COL2_X = 460
  const START_Y = 40
  // 行距必须不小于节点总高（含顶部栏），否则父子两排会重叠
  const ROW_GAP = LENS_ASSET_NODE_HEIGHT + 30
  const seenAssets = new Set<string>()
  const pickAssets = (category: number): LensAssetEnriched[] => {
    const out: LensAssetEnriched[] = []
    for (const asset of assets) {
      const assetKey = `${category}:${asset.assetId || asset.roleId || ''}`
      if (!assetKey || asset.assetCategory !== category || seenAssets.has(assetKey)) continue
      seenAssets.add(assetKey)
      out.push(asset)
    }
    return out
  }
  const roleAssets = pickAssets(1)
  const sceneAssets = pickAssets(2)
  const propAssets = pickAssets(3)

  /**
   * 按「父级 → 其子级列表」拆分资产，用于父子分组与派生连线。
   *
   * 子级判定：parentId 非空，且该父级也在本次投影结果中（父级需被分镜引用过才会出现）。
   * 父级缺失的子级（父级未被任何分镜引用）不编组、不连线，避免连到不存在的节点。
   */
  const splitParentChild = (list: LensAssetEnriched[], idOf: (a: LensAssetEnriched) => string) => {
    const byId = new Map<string, LensAssetEnriched>()
    for (const asset of list) {
      const id = idOf(asset)
      if (id) byId.set(id, asset)
    }
    const childrenByParent = new Map<string, LensAssetEnriched[]>()
    const roots: LensAssetEnriched[] = []
    for (const asset of list) {
      const parentId = String(asset.parentId ?? '').trim()
      const selfId = idOf(asset)
      // 父级存在且非自身时才归为子级，防止脏数据里 parentId 指向自己造成死循环
      if (parentId && parentId !== selfId && byId.has(parentId)) {
        const bucket = childrenByParent.get(parentId)
        if (bucket) bucket.push(asset)
        else childrenByParent.set(parentId, [asset])
      } else {
        roots.push(asset)
      }
    }
    return { roots, childrenByParent }
  }

  const roleIdOf = (a: LensAssetEnriched): string => String(a.roleId || a.assetId || '')
  const sceneIdOf = (a: LensAssetEnriched): string => String(a.assetId || '')

  const { roots: roleRoots, childrenByParent: roleChildrenByParent } = splitParentChild(roleAssets, roleIdOf)
  const { roots: sceneRoots, childrenByParent: sceneChildrenByParent } = splitParentChild(sceneAssets, sceneIdOf)

  /** 子节点行内排布：父节点下方一排，逐个向右展开 */
  const CHILD_GAP_X = 420

  // 第 1 列：角色（主身份）+ 其分身（父下方一排）
  let roleCursorY = START_Y
  roleRoots.forEach((asset) => {
    const assetId = roleIdOf(asset)
    const children = roleChildrenByParent.get(assetId) ?? []
    // 角色：只展示三视图（threeImg），全身图/近身图不处理
    addNode(`role-${assetId}`, 'image', asset.characterName || '角色', { x: COL1_X, y: roleCursorY }, {
      roleId: asset.roleId,
      roleName: asset.characterName,
      imageUrl: asset.threeImg,
      referenceView: 'three_view',
      anchorBindings: [{ kind: 'character', entityId: assetId, label: asset.characterName, imageUrl: asset.threeImg }],
      source: 'lens_projection',
      nodeWidth: LENS_ASSET_NODE_WIDTH,
      nodeHeight: LENS_ASSET_MEDIA_HEIGHT,
      lensTypeLabel: '角色',
      assetCategory: 1,
      entityId: assetId,
      prompt: asset.description || '',
    })
    rememberAssetNode(1, assetId, `role-${assetId}`)
    // 分身：父节点下一排，逐个向右；标记 parentEntityId 供运行时编入分组框
    children.forEach((child, childIndex) => {
      const childId = roleIdOf(child)
      addNode(
        `role-${childId}`,
        'image',
        child.characterName || '角色',
        { x: COL1_X + (childIndex + 1) * CHILD_GAP_X, y: roleCursorY + ROW_GAP },
        {
          roleId: child.roleId,
          roleName: child.characterName,
          imageUrl: child.threeImg,
          referenceView: 'three_view',
          // 父角色图由「父→子派生连线」进入上游参考区（见 pushDerivedEdges），
          // 不在 anchorBindings 里重复挂，避免参考图重复与语义重叠。
          anchorBindings: [{ kind: 'character', entityId: childId, label: child.characterName, imageUrl: child.threeImg }],
          source: 'lens_projection',
          nodeWidth: LENS_ASSET_NODE_WIDTH,
          nodeHeight: LENS_ASSET_MEDIA_HEIGHT,
          lensTypeLabel: '分身',
          assetCategory: 1,
          entityId: childId,
          parentEntityId: assetId,
          cloneName: child.cloneName,
          prompt: child.description || '',
        },
      )
      rememberAssetNode(1, childId, `role-${childId}`)
    })
    // 有分身时占两排高度，避免与下一个主角色重叠
    roleCursorY += ROW_GAP * (children.length > 0 ? 2 : 1)
  })
  // 角色列总占用高度（供后续列定位参考）
  const roleColumnBottom = roleCursorY

  // 第 2 列：场景（主场景 + 其子场景）+ 道具
  let sceneCursorY = START_Y
  sceneRoots.forEach((asset) => {
    const assetId = sceneIdOf(asset)
    const children = sceneChildrenByParent.get(assetId) ?? []
    addNode(`scene-${assetId}`, 'image', asset.imgName || '场景', { x: COL2_X, y: sceneCursorY }, {
      imageUrl: asset.imgUrl,
      anchorBindings: [{ kind: 'scene', entityId: assetId, label: asset.imgName, imageUrl: asset.imgUrl }],
      source: 'lens_projection',
      nodeWidth: LENS_ASSET_NODE_WIDTH,
      nodeHeight: LENS_ASSET_MEDIA_HEIGHT,
      lensTypeLabel: '场景',
      assetCategory: 2,
      entityId: assetId,
      prompt: asset.description || '',
    })
    rememberAssetNode(2, assetId, `scene-${assetId}`)
    // 子场景：父场景下一排，逐个向右；标记 parentEntityId 供运行时编入分组框
    children.forEach((child, childIndex) => {
      const childId = sceneIdOf(child)
      addNode(
        `scene-${childId}`,
        'image',
        child.imgName || '场景',
        { x: COL2_X + (childIndex + 1) * CHILD_GAP_X, y: sceneCursorY + ROW_GAP },
        {
          imageUrl: child.imgUrl,
          // 主场景图由「父→子派生连线」进入上游参考区（见 pushDerivedEdges），
          // 不在 anchorBindings 里重复挂，避免参考图重复与语义重叠。
          anchorBindings: [{ kind: 'scene', entityId: childId, label: child.imgName, imageUrl: child.imgUrl }],
          source: 'lens_projection',
          nodeWidth: LENS_ASSET_NODE_WIDTH,
          nodeHeight: LENS_ASSET_MEDIA_HEIGHT,
          lensTypeLabel: '子场景',
          assetCategory: 2,
          entityId: childId,
          parentEntityId: assetId,
          variantName: child.variantName,
          prompt: child.description || '',
        },
      )
      rememberAssetNode(2, childId, `scene-${childId}`)
    })
    sceneCursorY += ROW_GAP * (children.length > 0 ? 2 : 1)
  })
  // 道具接在场景列末尾
  const sceneColumnBottom = sceneCursorY
  propAssets.forEach((asset, index) => {
    const y = sceneColumnBottom + index * ROW_GAP
    const assetId = String(asset.assetId || '')
    addNode(`prop-${assetId}`, 'image', asset.imgName || '道具', { x: COL2_X, y }, {
      imageUrl: asset.imgUrl,
      anchorBindings: [{ kind: 'prop', entityId: assetId, label: asset.imgName, imageUrl: asset.imgUrl }],
      source: 'lens_projection',
      nodeWidth: LENS_ASSET_NODE_WIDTH,
      nodeHeight: LENS_ASSET_MEDIA_HEIGHT,
      lensTypeLabel: '道具',
      assetCategory: 3,
      entityId: assetId,
      prompt: asset.description || '',
    })
    rememberAssetNode(3, assetId, `prop-${assetId}`)
  })

  // 2. 剧本/台本文本节点（默认隐藏）：第 2 列道具下方，纵向按内容估算高度累计（避免叠加）
  const col2Count = propAssets.length
  const lastCol2Y = col2Count > 0
    ? sceneColumnBottom + (col2Count - 1) * ROW_GAP
    : sceneColumnBottom - ROW_GAP
  const estimateTextNodeHeight = (text: string): number => {
    const lines = Math.max(1, Math.ceil(String(text || '').length / 40))
    return Math.min(800, Math.max(160, lines * 20 + 80))
  }
  const TEXT_GAP = 40
  let scriptCursorY = lastCol2Y + 3 * 250
  addNode('script-content', 'text', '剧本原文', { x: COL2_X, y: scriptCursorY }, {
    prompt: script.content || '',
    hidden: true,
    source: 'lens_projection',
    lensTypeLabel: '剧本',
  })
  scriptCursorY += estimateTextNodeHeight(script.content || '') + TEXT_GAP
  addNode('script-script-content', 'text', '台本', { x: COL2_X, y: scriptCursorY }, {
    prompt: script.scriptContent || '',
    hidden: true,
    source: 'lens_projection',
    lensTypeLabel: '台本',
  })

  // 3. 分镜节点（单个 lensShot 节点，参考生视频；按 storyboardOrder 纵向排列）
  // 纵向布局：y 按上一节点预估高度累计 + 间距，横竖屏都不叠加
  const SHOT_COL_X = 1300
  const SHOT_GAP = 40
  let shotCursorY = START_Y
  storyboards.forEach((shot, index) => {
    const order = shot.storyboardOrder ?? index + 1
    const y = shotCursorY
    const shotId = `storyboard-${shot.id}`
    // 该分镜引用的资产（场景/道具/角色/站位），从 assets 按 refId 关联
    const speakerList = String(shot.speakerName || '').split(',').map((s) => s.trim()).filter(Boolean)
    const refs = buildShotRefsFromAssets(assets, String(shot.id), speakerList)
    nodes.push({
      id: shotId,
      type: 'lensShot',
      position: { x: SHOT_COL_X, y },
      data: {
        kind: 'lensShot',
        label: `分镜${order}`,
        entityId: shot.id,
        sourceProjectId: dramaId,
        storyboardOrder: order,
        episodeNum: shot.episodeNum,
        timeOfDay: shot.timeOfDay,
        time: shot.time,
        prompt: shot.prompt,
        scriptContent: shot.scriptContent,
        selectedImageUrl: shot.selectedImageUrl,
        selectFileType: shot.selectFileType ?? 0,
        videoStatus: shot.videoStatus ?? 0,
        analyzeState: shot.analyzeState ?? 0,
        lineArtStatus: shot.lineArtStatus ?? 0,
        speakerName: shot.speakerName,
        refs,
        source: 'lens_projection',
      },
    })
    // 引用连线：该分镜引用的资产节点 → 分镜节点（同资产只连一次）
    const connectedAssets = new Set<string>()
    for (const a of assets) {
      if (String(a.refId) !== String(shot.id)) continue
      const cat = a.assetCategory ?? 0
      if (cat !== 1 && cat !== 2 && cat !== 3) continue // 站位等无画布节点
      const sourceId = assetNodeIdByKey.get(`${cat}:${a.assetId || a.roleId || ''}`)
      if (!sourceId || connectedAssets.has(sourceId)) continue
      connectedAssets.add(sourceId)
      edges.push({ id: `edge-ref-${sourceId}-${shotId}`, source: sourceId, target: shotId })
    }
    // 按上一节点高度累计下一个分镜的 y（防叠加）
    shotCursorY += estimateShotNodeHeight(shotAspects?.get(String(shot.id)) ?? null, Boolean(showRefs)) + SHOT_GAP
  })

  // 派生连线：父 → 子（主角色→分身、主场景→子场景），表达「派生/同构」关系。
  // 独立于分镜引用连线，即子节点无论是否被分镜引用，都能看出它从属于哪个父级。
  const pushDerivedEdges = (parentChildMap: Map<string, LensAssetEnriched[]>, category: number, nodePrefix: string) => {
    parentChildMap.forEach((children, parentEntityId) => {
      const parentNodeId = assetNodeIdByKey.get(`${category}:${parentEntityId}`)
      if (!parentNodeId) return
      children.forEach((child) => {
        const childEntityId = category === 1 ? roleIdOf(child) : sceneIdOf(child)
        const childNodeId = assetNodeIdByKey.get(`${category}:${childEntityId}`)
        if (!childNodeId || childNodeId === parentNodeId) return
        edges.push({
          id: `edge-derived-${parentNodeId}-${childNodeId}`,
          source: parentNodeId,
          target: childNodeId,
        })
      })
    })
  }
  pushDerivedEdges(roleChildrenByParent, 1, 'role')
  pushDerivedEdges(sceneChildrenByParent, 2, 'scene')

  return { nodes, edges }
}

/** 画布入口组件 */
export default function LensCanvasApp(): JSX.Element {
  const { dramaId, episode: initialEpisode } = useMemo(() => readQueryParams(), [])
  const [episodeNum, setEpisodeNum] = useState<number>(initialEpisode)
  const [episodes, setEpisodes] = useState<LensEpisodeBrief[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string>('')
  const [flowVersion, setFlowVersion] = useState<number>(0)
  const [savedAt, setSavedAt] = useState<string>('')
  const [showRefs, setShowRefs] = useState<boolean>(false)
  // 分镜组：默认打开；打开时所有分镜节点编入一个组合框（组内位置固定、按分镜序号排列）
  const [shotGroupOn, setShotGroupOn] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true
    const raw = window.localStorage.getItem('lens_shot_group')
    return raw === null ? true : raw === '1'
  })
  // 排列方向：column=垂直（默认）、flow=水平
  const [shotArrange, setShotArrange] = useState<'column' | 'flow'>(() => {
    if (typeof window === 'undefined') return 'column'
    return window.localStorage.getItem('lens_shot_arrange') === 'flow' ? 'flow' : 'column'
  })
  const shotGroupIdRef = useRef<string | null>(null)
  // 任务结果抽屉的目标节点：null 表示关闭。点节点上的入口按钮时按节点类型组装。
  const [taskResultTarget, setTaskResultTarget] = useState<TaskResultTarget | null>(null)
  // 是否可查看任务请求参数（仅管理员，与 lens 分镜板 canViewParams 同口径）
  const [canViewParams, setCanViewParams] = useState<boolean>(false)
  // 已保存 flow 里的布局设置（排列方向 + 分组开关）：与当前一致时沿用保存的位置，不重新排列
  const loadedLayoutMetaRef = useRef<{ direction: 'column' | 'flow'; groupOn: boolean } | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadedForRef = useRef<string>('')
  // 最新 flow 版本（ref 同步，避免并发保存读到旧 version 触发「已被他人修改」）
  const flowVersionRef = useRef<number>(0)  // 保存进行中标志：防 debounce 自动保存与切集保存并发
  const savingRef = useRef<boolean>(false)
  // 最近一次「已成功保存」内容的签名：与当前内容一致时跳过保存，避免空写入。
  // 加载新集时置 null，保证新集的首次保存一定落库。
  const lastSavedSignatureRef = useRef<string | null>(null)
  /** 刷新后尚未建立「已保存」签名基准：首次自动保存只记录基准，不写库 */
  const pendingInitialSignatureRef = useRef(false)
  // 父子分组（分身/子场景）创建出的组框ID：整理画布时先解除、再重建
  const childGroupIdsRef = useRef<string[]>([])
  // 最近一次投影结果缓存：整理画布时恢复默认布局
  const lastProjectionRef = useRef<{ nodes: Node[]; edges: Edge[] } | null>(null)
  // 画布实例 API（视口读写经 Canvas ref 暴露，绕开 ReactFlowProvider 层级）
  const canvasApiRef = useRef<CanvasHandle>(null)

  // 读画布 store 状态与操作
  const nodes = useRFStore((s) => s.nodes)
  const edges = useRFStore((s) => s.edges)
  const load = useRFStore((s) => s.load)

  /** 切换引用行显隐（画布顶部开关，更新所有 lensShot 节点的 showRefs） */
  const toggleShowRefs = useCallback((checked: boolean) => {
    setShowRefs(checked)
    const state = useRFStore.getState()
    useRFStore.setState({
      nodes: state.nodes.map((n) =>
        n.type === 'lensShot' ? { ...n, data: { ...(n.data as Record<string, unknown>), showRefs: checked } } : n,
      ),
      edges: state.edges,
    })
  }, [])

  /**
   * 应用分镜组：按分镜序号排序 → 放到目标区域（垂直=最右侧 / 水平=最底部）→ 编入组合框 → 按方向排列 → 组内固定不可拖动
   */
  const applyShotGroup = useCallback((direction: 'column' | 'flow') => {
    const store = useRFStore.getState()
    const shots = store.nodes.filter((n) => n.type === 'lensShot')
    if (shots.length === 0) return
    // 已有组先解除，避免重复编组
    const existing = shots.find((n) => n.parentId)?.parentId
    if (existing) store.ungroupGroupNode(existing)
    // 目标区域：与「分镜组关闭」时的分镜位置一致（垂直→图片右侧；水平→剧本列右侧、图片下方）
    const origin = computeShotAreaOrigin(useRFStore.getState().nodes, direction)
    const baseX = origin.x
    const baseY = origin.y
    // 按分镜序号设置初始位置（排序基准为分镜序号，并落到目标区域）
    const ordered = [...shots].sort(
      (a, b) => Number((a.data as { storyboardOrder?: number })?.storyboardOrder ?? 0) - Number((b.data as { storyboardOrder?: number })?.storyboardOrder ?? 0),
    )
    const orderIndex = new Map(ordered.map((n, i) => [n.id, i] as const))
    useRFStore.setState({
      nodes: useRFStore.getState().nodes.map((n) => {
        const idx = orderIndex.get(n.id)
        if (idx === undefined) return n
        return { ...n, position: { x: baseX + idx * 10, y: baseY + idx * 10 } }
      }),
    })
    const groupId = useRFStore.getState().createGroupForNodeIds(ordered.map((n) => n.id), '分镜组')
    if (!groupId) return
    shotGroupIdRef.current = groupId
    // 组内位置固定：禁止拖动
    useRFStore.setState({
      nodes: useRFStore.getState().nodes.map((n) => (n.parentId === groupId ? { ...n, draggable: false } : n)),
    })
    // 等节点渲染测量完成后再排列并适配组框尺寸（竖版节点更高时组框需要跟着变高）
    window.setTimeout(() => {
      if (shotGroupIdRef.current !== groupId) return
      useRFStore.getState().arrangeGroupChildren(groupId, direction)
    }, 120)
    // 组框适配多时机重试：媒体（视频/图片）加载完成后节点高度变化，需再次适配
    ;[200, 600, 1400].forEach((delay) => {
      window.setTimeout(() => {
        if (shotGroupIdRef.current !== groupId) return
        useRFStore.getState().fitGroupToChildren(groupId)
      }, delay)
    })
  }, [])

  /** 解除分镜组：组合框消失、节点位置保持不变、恢复可拖动 */
  const clearShotGroup = useCallback(() => {
    const store = useRFStore.getState()
    const gid = shotGroupIdRef.current
      ?? store.nodes.find((n) => n.type === 'lensShot' && n.parentId)?.parentId
      ?? null
    if (gid) store.ungroupGroupNode(gid)
    useRFStore.setState({
      nodes: useRFStore.getState().nodes.map((n) => (n.type === 'lensShot' ? { ...n, draggable: true } : n)),
    })
    shotGroupIdRef.current = null
  }, [])

  /**
   * 应用父子分组：把每个父级（主角色/主场景）的子节点（分身/子场景）编入一个分组框。
   *
   * 规则：父节点留在组外，子节点同属一个组框；同一父级的多个子节点共用一个组。
   * 组框名取「父节点标签 · 子节点类型」（如「陆念安 · 分身」「办公室 · 子场景」），
   * 便于直接看出组内是哪种派生节点。
   *
   * 与分镜组一致地采用「运行时编组」：投影只负责标记 parentEntityId 与初始位置，
   * 组框尺寸依赖节点实际测量值，必须等渲染后再编组并适配。
   */
  const applyParentChildGroups = useCallback((): void => {
    const store = useRFStore.getState()
    // 幂等处理：先解除已存在的父子分组（组内子节点带 parentEntityId 即视为父子分组），
    // 避免重复调用（加载后 + 整理画布）叠加出多个组框。分镜组由 applyShotGroup 管理，不动。
    const existingChildGroupIds = new Set<string>()
    for (const n of store.nodes) {
      if (n.type !== 'groupNode') continue
      const isChildGroup = store.nodes.some(
        (child) => child.parentId === n.id
          && String((child.data as { parentEntityId?: string })?.parentEntityId ?? '').trim(),
      )
      if (isChildGroup) existingChildGroupIds.add(n.id)
    }
    // 解除旧组时记录组内子节点，解除后需恢复其可拖拽状态
    const releasedChildIds = new Set<string>()
    for (const gid of existingChildGroupIds) {
      for (const n of useRFStore.getState().nodes) {
        if (n.parentId === gid) releasedChildIds.add(n.id)
      }
      useRFStore.getState().ungroupGroupNode(gid)
    }
    if (releasedChildIds.size > 0) {
      useRFStore.setState({
        nodes: useRFStore.getState().nodes.map((n) =>
          releasedChildIds.has(n.id) ? { ...n, draggable: true } : n,
        ),
      })
    }
    childGroupIdsRef.current = []

    const all = useRFStore.getState().nodes
    // 按 parentEntityId 收集子节点（同父级一个组），并记录子节点的资产类别用于命名
    const childGroups = new Map<string, { ids: string[]; category: number }>()
    for (const n of all) {
      if (n.type === 'groupNode') continue
      const data = n.data as { parentEntityId?: string; assetCategory?: number }
      const parentEntityId = String(data?.parentEntityId ?? '').trim()
      if (!parentEntityId) continue
      const category = Number(data?.assetCategory ?? 0)
      const bucket = childGroups.get(parentEntityId)
      if (bucket) {
        bucket.ids.push(n.id)
        // 类别以子节点自身为准；同组内类别一致，取首个有效值即可
        if (!bucket.category && category) bucket.category = category
      } else {
        childGroups.set(parentEntityId, { ids: [n.id], category })
      }
    }
    if (childGroups.size === 0) return

    // assetCategory=1 → 分身；2 → 子场景（3 道具目前无子级，兜底用同构）
    const groupLabelOf = (parentEntityId: string, category: number): string => {
      const parent = all.find(
        (n) => String((n.data as { entityId?: string })?.entityId ?? '') === parentEntityId,
      )
      const label = String((parent?.data as { label?: string })?.label ?? '').trim()
      const suffix = category === 1 ? '分身' : category === 2 ? '子场景' : '同构'
      return label ? `${label} · ${suffix}` : suffix
    }

    childGroups.forEach(({ ids, category }, parentEntityId) => {
      const groupId = useRFStore.getState().createGroupForNodeIds(ids, groupLabelOf(parentEntityId, category))
      if (!groupId) return
      // 顶部留出可拖拽带：子节点固定在组内不可拖，其标题栏紧贴组框顶部时会被误认作
      // 组框标题，用户拖它拖不动。留白后组框顶部本身就是可拖拽区域。
      useRFStore.setState({
        nodes: useRFStore.getState().nodes.map((n) =>
          n.id === groupId ? { ...n, data: { ...(n.data || {}), topPadding: CHILD_GROUP_DRAG_BAND } } : n,
        ),
      })
      // 设置 topPadding 后立即按新规则重算组框尺寸与位置
      useRFStore.getState().fitGroupToChildren(groupId)
      childGroupIdsRef.current.push(groupId)
    })

    // 组内子节点固定不可拖拽：与分镜组一致，防止把子角色/子场景拖出组框导致脱离归属
    const createdGroupIdSet = new Set(childGroupIdsRef.current)
    if (createdGroupIdSet.size > 0) {
      useRFStore.setState({
        nodes: useRFStore.getState().nodes.map((n) =>
          n.parentId && createdGroupIdSet.has(n.parentId) ? { ...n, draggable: false } : n,
        ),
      })
    }

    // 组框尺寸适配：媒体加载完成后节点高度会变化，多时机重试
    const createdGroupIds = [...childGroupIdsRef.current]
    ;[120, 400, 1000].forEach((delay) => {
      window.setTimeout(() => {
        const state = useRFStore.getState()
        for (const gid of createdGroupIds) {
          // 组可能已被用户解除或重新整理，存在才适配
          if (state.nodes.some((n) => n.id === gid && n.type === 'groupNode')) {
            useRFStore.getState().fitGroupToChildren(gid)
          }
        }
      }, delay)
    })
  }, [])

  /**
   * 按方向整理整个画布（点击左下「排列」触发）：
   * - 垂直：剧本/台本最左纵排 → 图片（角色/场景/道具）纵排 → 分镜纵排（组开时为组框，位于最右）
   * - 水平：剧本/台本最左纵排 → 图片横排（在上）→ 分镜横排（在下，组开时为组框位于最底）
   *
   * 父子数据（主角色+分身、主场景+子场景）按「父节点 + 其子节点」作为一个整体占位：
   * 角色列按父角色逐个纵向排，每个父角色右侧展开其分身，避免父子被拆散。
   */
  const arrangeByDirection = useCallback((direction: 'column' | 'flow') => {
    const store = useRFStore.getState()
    const all = store.nodes
    // 整理前先解除全部旧组合（节点位置统一按绝对坐标计算）。
    // 画布上可能同时存在分镜组与多个父子分组（分身/子场景），必须全部解除，
    // 否则残留的组会与后续重建的组嵌套或错位。
    const groupIds = all.filter((n) => n.type === 'groupNode').map((n) => n.id)
    if (groupIds.length > 0) {
      // 解除前记录组内子节点，解除后恢复可拖拽（组内节点此前被固定为不可拖）
      const groupIdSet = new Set(groupIds)
      const releasedIds = new Set<string>()
      for (const n of all) {
        if (n.parentId && groupIdSet.has(n.parentId)) releasedIds.add(n.id)
      }
      for (const gid of groupIds) {
        useRFStore.getState().ungroupGroupNode(gid)
      }
      if (releasedIds.size > 0) {
        useRFStore.setState({
          nodes: useRFStore.getState().nodes.map((n) =>
            releasedIds.has(n.id) ? { ...n, draggable: true } : n,
          ),
        })
      }
    }
    childGroupIdsRef.current = []

    const sizeOf = arrangeNodeSize
    const isScriptNode = isLensScriptNode
    const isAssetNode = isLensAssetNode

    const current = useRFStore.getState().nodes
    const scripts = current.filter(isScriptNode)
    const assets = current.filter(isAssetNode)
    // 资产分两组：角色（第 1 组）与场景/道具（第 2 组，排在角色的下一列/下一排）
    const roleAssets = assets.filter((n) => Number((n.data as { assetCategory?: number })?.assetCategory) === 1)
    const scenePropAssets = assets.filter((n) => {
      const cat = Number((n.data as { assetCategory?: number })?.assetCategory)
      return cat === 2 || cat === 3
    })
    const shots = current.filter((n) => n.type === 'lensShot').sort(
      (a, b) => Number((a.data as { storyboardOrder?: number })?.storyboardOrder ?? 0) - Number((b.data as { storyboardOrder?: number })?.storyboardOrder ?? 0),
    )

    /**
     * 把一组资产按「父 + 其子节点」拆成若干单元，保持父子相邻。
     * 返回顺序：父节点紧跟着它的子节点，再进入下一个父节点。
     */
    const groupByParent = (list: Node[]): Array<{ parent: Node; children: Node[] }> => {
      const entityIdOf = (n: Node): string => String((n.data as { entityId?: string })?.entityId ?? '')
      const byId = new Map(list.map((n) => [entityIdOf(n), n] as const))
      const childrenOf = new Map<string, Node[]>()
      const roots: Node[] = []
      for (const n of list) {
        const parentEntityId = String((n.data as { parentEntityId?: string })?.parentEntityId ?? '').trim()
        if (parentEntityId && byId.has(parentEntityId)) {
          const bucket = childrenOf.get(parentEntityId)
          if (bucket) bucket.push(n)
          else childrenOf.set(parentEntityId, [n])
        } else {
          roots.push(n)
        }
      }
      const units = roots.map((parent) => ({ parent, children: childrenOf.get(entityIdOf(parent)) ?? [] }))
      // 父节点缺失的子节点（父未被引用）作为独立单元保留，避免节点丢失
      const placed = new Set<string>()
      units.forEach((u) => {
        placed.add(entityIdOf(u.parent))
        u.children.forEach((c) => placed.add(entityIdOf(c)))
      })
      list.forEach((n) => {
        if (!placed.has(entityIdOf(n))) units.push({ parent: n, children: [] })
      })
      return units
    }

    const START = ARRANGE_START
    const GAP = ARRANGE_GAP
    const SECTION_GAP = ARRANGE_SECTION_GAP
    const nextPos = new Map<string, { x: number; y: number }>()

    // 1. 剧本/台本：无论哪种排列都放最左侧，纵向排列
    let scriptCursorY = START
    let scriptColWidth = 0
    scripts.forEach((n) => {
      nextPos.set(n.id, { x: START, y: scriptCursorY })
      scriptCursorY += sizeOf(n).h + GAP
      scriptColWidth = Math.max(scriptColWidth, sizeOf(n).w)
    })
    const contentX = START + (scripts.length > 0 ? scriptColWidth + SECTION_GAP : 0)

    const roleUnits = groupByParent(roleAssets)
    const scenePropUnits = groupByParent(scenePropAssets)

    if (direction === 'column') {
      // 2. 角色：每个父角色占一列（父在上，其分身在其右侧同排展开）
      let roleColWidth = 0
      let roleCursorY = START
      roleUnits.forEach((unit) => {
        nextPos.set(unit.parent.id, { x: contentX, y: roleCursorY })
        let childX = contentX + sizeOf(unit.parent).w + GAP
        let unitHeight = sizeOf(unit.parent).h
        unit.children.forEach((child) => {
          nextPos.set(child.id, { x: childX, y: roleCursorY })
          childX += sizeOf(child).w + GAP
          unitHeight = Math.max(unitHeight, sizeOf(child).h)
        })
        roleColWidth = Math.max(roleColWidth, childX - contentX - GAP)
        roleCursorY += unitHeight + GAP
      })
      // 3. 场景/道具：角色的下一列纵向排列（同样保持父子同排）
      const sceneColX = contentX + (roleUnits.length > 0 ? roleColWidth + SECTION_GAP : 0)
      let sceneColWidth = 0
      let sceneCursorY = START
      scenePropUnits.forEach((unit) => {
        nextPos.set(unit.parent.id, { x: sceneColX, y: sceneCursorY })
        let childX = sceneColX + sizeOf(unit.parent).w + GAP
        let unitHeight = sizeOf(unit.parent).h
        unit.children.forEach((child) => {
          nextPos.set(child.id, { x: childX, y: sceneCursorY })
          childX += sizeOf(child).w + GAP
          unitHeight = Math.max(unitHeight, sizeOf(child).h)
        })
        sceneColWidth = Math.max(sceneColWidth, childX - sceneColX - GAP)
        sceneCursorY += unitHeight + GAP
      })
      // 4. 分镜：组关闭时在图片右侧纵向排列，与图片之间空出一个图片宽度
      if (!shotGroupOn) {
        const assetsWidth = (roleUnits.length + scenePropUnits.length > 0
          ? Math.max(roleColWidth, scenePropUnits.length > 0 ? roleColWidth + SECTION_GAP + sceneColWidth : 0)
          : 0)
        const gapByImage = roleColWidth || sceneColWidth || 480
        const assetRight = contentX + assetsWidth + gapByImage + SECTION_GAP
        let shotY = START
        shots.forEach((n) => {
          nextPos.set(n.id, { x: assetRight, y: shotY })
          shotY += sizeOf(n).h + GAP
        })
      }
    } else {
      // 2. 角色：父角色逐个横向排列，其分身排在父的下方一排
      let roleCursorX = contentX
      let roleRowHeight = 0
      roleUnits.forEach((unit) => {
        const parentSize = sizeOf(unit.parent)
        nextPos.set(unit.parent.id, { x: roleCursorX, y: START })
        let unitWidth = parentSize.w
        unit.children.forEach((child, childIndex) => {
          nextPos.set(child.id, { x: roleCursorX + childIndex * (parentSize.w + GAP), y: START + parentSize.h + GAP })
          unitWidth = Math.max(unitWidth, (childIndex + 1) * (parentSize.w + GAP) - GAP)
          roleRowHeight = Math.max(roleRowHeight, parentSize.h + GAP + sizeOf(child).h)
        })
        if (unit.children.length === 0) roleRowHeight = Math.max(roleRowHeight, parentSize.h)
        roleCursorX += unitWidth + GAP
      })
      // 3. 场景/道具：角色的下一排横向排列
      const sceneRowY = START + (roleUnits.length > 0 ? roleRowHeight + SECTION_GAP : 0)
      let sceneCursorX = contentX
      let sceneRowHeight = 0
      scenePropUnits.forEach((unit) => {
        const parentSize = sizeOf(unit.parent)
        nextPos.set(unit.parent.id, { x: sceneCursorX, y: sceneRowY })
        let unitWidth = parentSize.w
        unit.children.forEach((child, childIndex) => {
          nextPos.set(child.id, { x: sceneCursorX + childIndex * (parentSize.w + GAP), y: sceneRowY + parentSize.h + GAP })
          unitWidth = Math.max(unitWidth, (childIndex + 1) * (parentSize.w + GAP) - GAP)
          sceneRowHeight = Math.max(sceneRowHeight, parentSize.h + GAP + sizeOf(child).h)
        })
        if (unit.children.length === 0) sceneRowHeight = Math.max(sceneRowHeight, parentSize.h)
        sceneCursorX += unitWidth + GAP
      })
      // 4. 分镜：组关闭时在图片下方横向排列，与图片之间同样空出一个图片宽度
      if (!shotGroupOn) {
        const assetsBottom = scenePropUnits.length > 0
          ? sceneRowY + sceneRowHeight
          : (roleUnits.length > 0 ? START + roleRowHeight : START - SECTION_GAP)
        const gapByImage = 480
        const shotY = assetsBottom + gapByImage + SECTION_GAP
        let shotX = contentX
        shots.forEach((n) => {
          nextPos.set(n.id, { x: shotX, y: shotY })
          shotX += sizeOf(n).w + GAP
        })
      }
    }

    useRFStore.setState({
      nodes: useRFStore.getState().nodes.map((n) => {
        const p = nextPos.get(n.id)
        return p ? { ...n, position: p, parentId: undefined } : n
      }),
    })

    // 4. 分镜组：开启时重新编组并按方向排列（垂直→最右、水平→最底）
    if (shotGroupOn) {
      window.setTimeout(() => applyShotGroup(direction), 80)
    }
    // 5. 父子分组：子节点编入组框（父节点留在组外），需等分镜组先落位再编组
    window.setTimeout(() => applyParentChildGroups(), shotGroupOn ? 240 : 120)
  }, [shotGroupOn, applyShotGroup, applyParentChildGroups])

  /**
   * 计算保存内容的签名（用于跳过无实质变更的保存）。
   *
   * 只对「会被持久化且影响结果」的字段取签名：节点编排、连线、视口、布局元信息。
   * 不含节点选中态、拖动中状态等运行期字段，避免点击/选中就触发保存。
   *
   * 采用 JSON 序列化后比较字符串，而不是 MD5：一是浏览器端无需引入哈希库，
   * 二是 JSON.stringify 同时可直接作为请求体，避免「算一次哈希再序列化一次」的重复开销。
   */
  const buildFlowSignature = useCallback((payload: {
    nodes: Node[]
    edges: Edge[]
    viewport: { x: number; y: number; zoom: number }
    arrangeDirection: 'column' | 'flow'
    shotGroupOn: boolean
  }): { signature: string; data: Record<string, unknown> } => {
    const data: Record<string, unknown> = {
      nodes: serializeNodesForFlow(payload.nodes),
      edges: payload.edges,
      viewport: payload.viewport,
      layoutVersion: LAYOUT_VERSION,
      arrangeDirection: payload.arrangeDirection,
      shotGroupOn: payload.shotGroupOn,
    }
    // 签名复用同一份序列化结果，避免「算签名」与「发请求」各序列化一次
    return { signature: JSON.stringify(data), data }
  }, [])

  /** 保存当前编排（立即，切集前用）。用 ref 记录最新版本，避免并发保存读到旧 version */
  const saveNow = useCallback(async (targetEpisode: number, snapshot: { nodes: Node[]; edges: Edge[] }): Promise<boolean> => {
    if (!dramaId || savingRef.current) return false
    const viewport = canvasApiRef.current?.getViewport() ?? { x: 0, y: 0, zoom: 1 }
    // 无实质变更则跳过：避免定时器、切换开关、加载后重排等场景产生大量空写入
    const { signature, data } = buildFlowSignature({
      nodes: snapshot.nodes,
      edges: snapshot.edges,
      viewport,
      arrangeDirection: shotArrange,
      shotGroupOn,
    })
    // 首次保存（尚无 flow）必须落库；已有 flow 且内容未变则直接跳过
    if (signature === lastSavedSignatureRef.current) return true
    savingRef.current = true
    try {
      const res = await saveFlow(dramaId, targetEpisode, {
        name: `第${targetEpisode}集`,
        data,
        version: flowVersionRef.current,
      })
      // 仅在保存成功后记录签名，失败时下次仍可重试
      lastSavedSignatureRef.current = signature
      flowVersionRef.current = (res?.version ?? 0) + 1
      setFlowVersion(flowVersionRef.current)
      // 同一集再次保存时 id 不变，但首次保存会新建 flow，必须同步给提交链路
      // （自由节点的任务归属要用它写 task_queue.scene_id）
      setLensCanvasFlowId(res?.id ?? null)
      setSavedAt(new Date().toLocaleTimeString())
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : '保存失败'
      if (msg.includes('已被他人修改')) {
        setError('编排已被他人修改，请刷新后重试')
      } else {
        setError(`编排保存失败：${msg}`)
      }
      return false
    } finally {
      savingRef.current = false
    }
  }, [dramaId, setSavedAt, shotArrange, shotGroupOn])

  /** 切集：先自动保存当前集，再加载新集 */
  const switchEpisode = useCallback(async (next: number) => {
    if (next === episodeNum) return
    const snapshot = { nodes: useRFStore.getState().nodes, edges: useRFStore.getState().edges }
    await saveNow(episodeNum, snapshot) // 切集前自动保存当前集（不等 debounce）
    setEpisodeNum(next)
  }, [episodeNum, saveNow])

  /** 整理画布：恢复默认打开时的投影布局（左下工具条「整理画布」按钮 / ⌥⌘F） */
  const arrangeLayout = useCallback(() => {
    const projection = lastProjectionRef.current
    if (!projection) return
    load({ nodes: projection.nodes, edges: projection.edges })
    window.setTimeout(() => { canvasApiRef.current?.fitView() }, 60)
  }, [load])

  /** 加载某集数据（投影节点 + 恢复编排） */
  const loadEpisode = useCallback(async (targetEpisode: number) => {
    if (!dramaId) return
    const key = `${dramaId}:${targetEpisode}`
    if (loadedForRef.current === key) return
    loadedForRef.current = key
    loadedLayoutMetaRef.current = null
    // 切换集后内容完全不同，清空上一次的保存签名：保证新集首次保存一定落库，
    // 避免新集内容恰好与上一集签名相同（如两集都是默认布局的空编排）而被误跳过。
    lastSavedSignatureRef.current = null
    setLoading(true)
    setError('')
    try {
      // 1. 拉 lens 业务数据
      const [storyboards, assets, script] = await Promise.all([
        listStoryboards(dramaId, targetEpisode),
        getEpisodeAssets(dramaId, targetEpisode),
        getScriptContent(dramaId, targetEpisode),
      ])
      // 2. 预加载分镜媒体宽高比（用于纵向布局按高度累计，防叠加），再投影成节点
      const shotAspects = await loadShotAspects(storyboards)
      const projected = buildCanvasNodes({ storyboards, assets, script, dramaId, shotAspects, showRefs })
      lastProjectionRef.current = projected
      // 3. 恢复编排（有 flow 则用 flow 的位置/连线，无则用投影默认布局）
      const flow = await getFlow(dramaId, targetEpisode)
      flowVersionRef.current = flow?.version ?? 0
      setFlowVersion(flowVersionRef.current)
      // 注入画布编排ID：自由节点提交任务时用它写 task_queue.scene_id 做归属隔离。
      // 无 flow（首次打开且未保存）时为 null，此时提交不传归属，不会写错归属。
      setLensCanvasFlowId(flow?.id ?? null)
      if (flow?.data) {
        try {
          const parsed = JSON.parse(flow.data) as { nodes?: Node[]; edges?: Edge[]; viewport?: { x: number; y: number; zoom: number }; layoutVersion?: number; arrangeDirection?: 'column' | 'flow'; shotGroupOn?: boolean }
          if (Array.isArray(parsed.nodes) && parsed.nodes.length > 0) {
            // 布局版本不一致：旧 flow 的绝对位置作废，改用最新投影布局（业务字段仍以投影快照为准）
            const useFlowLayout = parsed.layoutVersion === LAYOUT_VERSION
            // 记录保存时的排列方向与分组状态（与当前一致则沿用位置，不重排）
            if (parsed.arrangeDirection && typeof parsed.shotGroupOn === 'boolean') {
              loadedLayoutMetaRef.current = { direction: parsed.arrangeDirection, groupOn: parsed.shotGroupOn }
            }
            // 引用模式：flow 里只有编排 + entityId；业务展示字段用最新投影快照覆盖
            const projectedIds = new Set(projected.nodes.map((p) => p.id))
            const restored = parsed.nodes
              // 投影节点必须以最新投影为准：lens 侧分镜被重新拆分（软删旧分镜 + 全新 id）
              // 或角色被删除后，flow 里残留的旧节点必须丢弃，否则旧实体会作为幽灵节点
              // 复活并与新数据并存。自由节点没有 lens 实体身份，投影里必然不存在，需无条件保留。
              .filter((n) => (isLensProjectionNode(n) ? projectedIds.has(n.id) : true))
              .map((n) => {
                const fresh = projected.nodes.find((p) => p.id === n.id)
                if (!fresh) return n
                const nData = n.data as Record<string, unknown>
                const freshData = fresh.data as Record<string, unknown>
                // 业务展示字段以最新投影快照为准；引用行开关（showRefs）是编排 UI 状态，以 flow 为准避免被覆盖丢失
                // 节点尺寸例外：用户拖拽调整过的宽高必须保留（以 flow 为准），
                // 否则每次刷新都会被投影默认值（384x250）重置，导致与衍生节点视觉不一致
                const merged = {
                  ...n,
                  data: {
                    ...nData,
                    ...freshData,
                    ...(typeof nData.nodeWidth === 'number' ? { nodeWidth: nData.nodeWidth } : null),
                    ...(typeof nData.nodeHeight === 'number' ? { nodeHeight: nData.nodeHeight } : null),
                    showRefs: typeof nData.showRefs === 'boolean' ? nData.showRefs : Boolean(freshData.showRefs),
                  },
                }
                // 布局版本不一致：位置与节点类型都以最新投影为准（如 asset 节点类型变化）
                return useFlowLayout ? merged : { ...merged, type: fresh.type, position: fresh.position }
              })
            // 同步顶部「引用」开关状态（与恢复出的分镜节点一致）
            const restoredShot = restored.find((nd) => nd.type === 'lensShot')
            if (restoredShot) {
              setShowRefs(Boolean((restoredShot.data as Record<string, unknown>)?.showRefs))
            }
            // 连线：布局版本一致时尊重 flow 里的连线（用户手动改过）；不一致时用最新投影引用连线
            const restoredEdges = useFlowLayout
              ? (Array.isArray(parsed.edges) ? parsed.edges : [])
              : projected.edges
            load({ nodes: restored, edges: restoredEdges })
            if (parsed.viewport) {
              const vp = parsed.viewport
              window.setTimeout(() => { canvasApiRef.current?.setViewport(vp) }, 0)
            }
            return
          }
        } catch {
          // flow data 损坏：用默认投影（错误已在 getFlow 阶段捕获过，这里走兜底布局）
        }
      }
      load({ nodes: projected.nodes, edges: projected.edges })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加载失败'
      setError(`画布加载失败：${msg}（可刷新重试或返回分镜板）`)
    } finally {
      setLoading(false)
      // 刷新后延迟建立「已保存」签名基准：此时布局重排与 viewport 恢复已完成，
      // 基准准确后 30s 的自动保存会因签名相同而跳过，不再每次刷新都白写一次库。
      // 5s 窗口内刷新/关闭页面也不保存（见 visibilitychange 守卫）。
      pendingInitialSignatureRef.current = true
      window.setTimeout(() => {
        if (!pendingInitialSignatureRef.current) return
        try {
          const state = useRFStore.getState()
          const viewport = canvasApiRef.current?.getViewport() ?? { x: 0, y: 0, zoom: 1 }
          const { signature } = buildFlowSignature({
            nodes: state.nodes,
            edges: state.edges,
            viewport,
            arrangeDirection: shotArrange,
            shotGroupOn,
          })
          lastSavedSignatureRef.current = signature
        } catch {
          // 基准建立失败只影响「少存一次」，不影响功能
        }
        pendingInitialSignatureRef.current = false
      }, 5000)
    }
  }, [dramaId, load, buildFlowSignature, shotArrange, shotGroupOn])

  // 加载集列表（选集下拉）
  useEffect(() => {
    if (!dramaId) { setError('缺少 dramaId 参数'); setLoading(false); return }
    listEpisodes(dramaId).then(setEpisodes).catch(() => setEpisodes([]))
  }, [dramaId])

  // 查询「查看参数」权限（仅管理员可见该按钮，与 lens 分镜板同口径）。
  // 失败时保持 false（不静默放行），属敏感能力。
  useEffect(() => {
    let alive = true
    canViewTaskParams()
      .then((ok) => { if (alive) setCanViewParams(ok) })
      .catch(() => { if (alive) setCanViewParams(false) })
    return () => { alive = false }
  }, [])

  // 选集加载
  useEffect(() => { void loadEpisode(episodeNum) }, [episodeNum, loadEpisode])

  // 若保存的 flow 就是当前方向与分组状态，则沿用保存的位置（记住用户调整），不重新排列；
  // 但父子分组（分身/子场景）是数据固有结构，仍需确保成组，否则从 flow 恢复时不会出现分组框。
  useEffect(() => {
    if (loading) return
    const meta = loadedLayoutMetaRef.current
    if (meta && meta.direction === shotArrange && meta.groupOn === shotGroupOn) {
      const timer = window.setTimeout(() => { applyParentChildGroups() }, 200)
      return () => window.clearTimeout(timer)
    }
    const timer = window.setTimeout(() => {
      arrangeByDirection(shotArrange)
    }, 120)
    return () => window.clearTimeout(timer)
  }, [shotGroupOn, shotArrange, loading, arrangeByDirection, applyParentChildGroups])

  // 编排自动保存（debounce 30s：任务进度/日志会频繁更新节点，间隔过短会反复写库；
  // 新建节点、切集、页面切后台都有独立的立即保存兜底）
  useEffect(() => {
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
    if (loading || loadedForRef.current !== `${dramaId}:${episodeNum}`) return
    saveTimerRef.current = setTimeout(() => {
      const state = useRFStore.getState()
      // 刷新后的首次自动保存：只记录当前签名作为「已保存」基准，不写库，
      // 避免每次刷新都无意义地保存一次
      if (pendingInitialSignatureRef.current) {
        pendingInitialSignatureRef.current = false
        const viewport = canvasApiRef.current?.getViewport() ?? { x: 0, y: 0, zoom: 1 }
        const { signature } = buildFlowSignature({
          nodes: state.nodes,
          edges: state.edges,
          viewport,
          arrangeDirection: shotArrange,
          shotGroupOn,
        })
        lastSavedSignatureRef.current = signature
        return
      }
      void saveNow(episodeNum, { nodes: state.nodes, edges: state.edges })
    }, 30000)
    return () => {
      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
    }
  }, [nodes, edges, loading, episodeNum, dramaId, saveNow, buildFlowSignature, shotArrange, shotGroupOn])

  /**
   * 页面切到后台立即保存：自动保存间隔拉长到 15s 后，直接关闭标签页可能丢失
   * 最近改动（拖拽位置、提示词编辑等）。visibilitychange 比 beforeunload 可靠，
   * 页面隐藏时异步请求通常能完成。
   */
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'hidden') return
      if (loading) return
      if (loadedForRef.current !== `${dramaId}:${episodeNum}`) return
      // 基准还没建立（刚加载完）时直接跳过：刷新/关闭页面不应触发保存
      if (pendingInitialSignatureRef.current) return
      // 刷新/关闭页面同样会触发 hidden，若内容没变不能白发一次保存请求
      const state = useRFStore.getState()
      const viewport = canvasApiRef.current?.getViewport() ?? { x: 0, y: 0, zoom: 1 }
      const { signature } = buildFlowSignature({
        nodes: state.nodes,
        edges: state.edges,
        viewport,
        arrangeDirection: shotArrange,
        shotGroupOn,
      })
      if (signature === lastSavedSignatureRef.current) return
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      void saveNow(episodeNum, { nodes: state.nodes, edges: state.edges })
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [loading, episodeNum, dramaId, saveNow, buildFlowSignature, shotArrange, shotGroupOn])

  /**
   * 新建节点立即落库：自动保存是 debounce，用户新建节点（尤其还没生成图）
   * 后 3 秒内刷新会直接丢失。这里监听「纯新增」（节点集合多了 id、没有删除），
   * 立即保存一次；切集/重投影会伴随大量 id 变化，不触发。
   */
  const prevNodeIdSetRef = useRef<Set<string> | null>(null)
  // 加载完成后短暂冷却：加载期间与紧随其后的布局重排/分组会新增节点，
  // 这些不是用户操作，不能触发「新建节点立即保存」
  const nodeIdSetArmedAtRef = useRef(0)
  useEffect(() => {
    if (loading) {
      prevNodeIdSetRef.current = null
      nodeIdSetArmedAtRef.current = Date.now() + 2000
      return
    }
    const currentNodes = useRFStore.getState().nodes
    const idSet = new Set(currentNodes.map((node) => node.id))
    const prevIdSet = prevNodeIdSetRef.current
    prevNodeIdSetRef.current = idSet
    if (!prevIdSet || prevIdSet.size === 0) return
    if (Date.now() < nodeIdSetArmedAtRef.current) return
    let hasAdded = false
    let hasRemoved = false
    idSet.forEach((id) => { if (!prevIdSet.has(id)) hasAdded = true })
    prevIdSet.forEach((id) => { if (!idSet.has(id)) hasRemoved = true })
    if (!hasAdded || hasRemoved) return
    if (loading) return
    if (loadedForRef.current !== `${dramaId}:${episodeNum}`) return
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    void saveNow(episodeNum, { nodes: currentNodes, edges: useRFStore.getState().edges })
  }, [nodes.length, loading, episodeNum, dramaId, saveNow])

  const episodeOptions = episodes.map((e) => ({
    value: String(e.episodeNumber),
    label: `第${e.episodeNumber}集${e.title ? ` · ${e.title}` : ''}`,
  }))

  /**
   * 按节点组装「任务结果」查询目标。
   *
   * <p>数据来源按节点类型区分（后端接口/表都不同）：
   * 分镜走 storyboardTask；角色/场景/道具走各自业务实体，自由节点不接入。
   * 取不到必要标识时返回 null（不静默降级查全量，避免展示错误结果）。
   */
  const resolveTaskResultTarget = useCallback((nodeId: string): TaskResultTarget | null => {
    const node = useRFStore.getState().nodes.find((n) => n.id === nodeId)
    if (!node) return null
    const data = (node.data || {}) as Record<string, unknown>
    const entityId = data.entityId === undefined || data.entityId === null ? '' : String(data.entityId).trim()

    // 分镜节点：按 storyboardId 查生视频任务
    if (node.type === 'lensShot') {
      if (!entityId) return null
      return {
        nodeId,
        title: `分镜${data.storyboardOrder ?? '-'}`,
        kind: 'storyboard',
        dramaId,
        storyboardId: entityId,
      }
    }

    // 业务资产节点（角色/场景/道具）：entityId 即 lens_role.id / lens_asset_image.id
    const assetCategory = Number(data.assetCategory)
    if (entityId && (assetCategory === 1 || assetCategory === 2 || assetCategory === 3)) {
      // assetCategory: 1=角色 2=场景 3=道具（对齐 lens_asset_relation.asset_category）
      const kind: TaskResultTarget['kind'] =
        assetCategory === 1 ? 'role' : assetCategory === 2 ? 'scene' : 'prop'
      return {
        nodeId,
        title: String(data.label || entityId),
        kind,
        dramaId,
        entityId,
      }
    }

    // 自由生图节点暂不接入资产任务列表，禁止降级查全量任务。
    return null
  }, [dramaId])

  /**
   * 点节点上的「任务结果」入口时调用。
   *
   * <p>按节点类型组装查询目标后打开抽屉；取不到归属信息时不静默降级（不查全量），
   * 而是提示用户该节点缺少有效业务资产ID。
   */
  const handleOpenTaskResult = useCallback(
    (nodeId: string) => {
      const target = resolveTaskResultTarget(nodeId)
      if (!target) {
        toast('该节点没有有效的业务资产ID，暂不支持任务列表')
        return
      }
      setTaskResultTarget(target)
    },
    [resolveTaskResultTarget],
  )

  /**
   * 「采纳结果」落库成功后的节点级刷新。
   *
   * <p>为什么不调 loadEpisode：LensCanvasApp 的 loadEpisode 有幂等守卫
   * （loadedForRef 命中同一 `dramaId:episode` 直接 return），同一集再调不会真正刷新。
   * 因此这里用画布 store 的 {@link useRFStore} updateNodeData 就地回写该节点的
   * selectedImageUrl / selectFileType —— 与 Lens 投影时写入节点 data 的字段完全一致，
   * 不新增平行刷新链路（分镜节点的 selectedImageUrl/selectFileType 就是它的选中结果）。
   */
  const handleAdoptResult = useCallback(
    (payload: TaskResultAdoptedPayload) => {
      useRFStore.getState().updateNodeData(payload.nodeId, {
        selectedImageUrl: payload.resultUrl,
        // 0=图 1=视频，与 lens_storyboard.select_file_type 同口径
        selectFileType: payload.resultType === 'video' ? 1 : 0,
      })
    },
    [],
  )

  return (
    <div className="lens-canvas-app">
      <Group className="lens-canvas-topbar" p={8} gap="xs" justify="space-between">
        <Group gap="xs">
          <Text size="sm" fw={600}>画布</Text>
          <Select
            className="lens-canvas-episode-select"
            size="xs"
            placeholder="选集"
            value={String(episodeNum)}
            onChange={(v) => { const next = Number(v); if (Number.isFinite(next)) void switchEpisode(next) }}
            data={episodeOptions.length > 0 ? episodeOptions : [{ value: String(episodeNum), label: `第${episodeNum}集` }]}
            w={180}
          />
          {/* <Switch
            className="lens-canvas-refs-switch"
            size="xs"
            label="引用"
            checked={showRefs}
            onChange={(e) => toggleShowRefs(e.currentTarget.checked)}
          /> */}
          <Switch
            className="lens-canvas-shot-group-switch"
            size="xs"
            label="分镜组"
            checked={shotGroupOn}
            onChange={(e) => {
              const on = e.currentTarget.checked
              // 手动切换开关时必须作废「已加载布局元信息」，否则下方布局恢复 effect 会因
              // meta.groupOn 与开关状态一致而只重排父子分组、不重建分镜组，
              // 导致关闭后重新打开分镜组无法恢复（组框不出现）。
              loadedLayoutMetaRef.current = null
              setShotGroupOn(on)
              window.localStorage.setItem('lens_shot_group', on ? '1' : '0')
              // 关闭时立即解除分镜组，让节点先恢复可拖动，再由布局 effect 重排
              if (!on) clearShotGroup()
            }}
          />

        </Group>
        <Group gap="xs">
          {savedAt && <Text size="xs" c="dimmed">已保存 {savedAt}</Text>}
          <Button
            size="xs"
            variant="light"
            onClick={() => {
              const target = window.location.pathname.includes('/project/detail/') ? '/project/detail' : '/'
              window.location.href = '/'
            }}
          >
            返回分镜板
          </Button>
        </Group>
      </Group>
      {error && <Alert className="lens-canvas-error" color="red" title="提示" mb={8}>{error}</Alert>}
      <div className="lens-canvas-body" style={{ position: 'relative', height: 'calc(100vh - 56px)' }}>
        <LoadingOverlay visible={loading} />
        {/* 任务结果入口必须走 Canvas 的 prop：
            Canvas 内部自渲染 CanvasRenderContext.Provider，外层再包一层会被内层覆盖，
            节点侧永远拿到 undefined（按钮不显示）。 */}
        <Canvas
          className="app-canvas"
          ref={canvasApiRef}
          arrangeHandler={arrangeLayout}
          shotArrange={shotArrange}
          onOpenTaskResult={handleOpenTaskResult}
          onShotArrangeChange={(direction) => {
            setShotArrange(direction)
            window.localStorage.setItem('lens_shot_arrange', direction)
            // 点击「排列」即按新方向整理整个画布（图片/分镜/剧本位置 + 分镜组）
            arrangeByDirection(direction)
          }}
        />
      </div>
      {/* 任务结果抽屉：点节点上的入口按钮打开，只读展示该节点历史生成结果 */}
      <TaskResultDrawer
        opened={taskResultTarget !== null}
        target={taskResultTarget}
        onClose={() => setTaskResultTarget(null)}
        canViewParams={canViewParams}
        onAdoptResult={handleAdoptResult}
      />
      {/* 大图预览弹窗：lens 画布路由提前 return，需在此挂载（否则双击图片无预览） */}
      <PreviewModal />
    </div>
  )
}
