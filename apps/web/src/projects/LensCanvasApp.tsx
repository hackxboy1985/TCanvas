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
import type { CanvasHandle } from '../canvas/Canvas'
import { useRFStore } from '../canvas/store'
import type { LensShotRef } from '../canvas/nodes/LensShotNode'
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
  type LensScriptContent,
} from '../api/lens'

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
 */
const LAYOUT_VERSION = 4

/** 把 lens 数据投影成 React Flow 节点与引用连线（引用模式：节点只存 entityId，展示字段为投影快照） */
function buildCanvasNodes(input: {
  storyboards: LensStoryboard[]
  assets: LensAssetEnriched[]
  script: LensScriptContent
  dramaId: string
}): { nodes: Node[]; edges: Edge[] } {
  const { storyboards, assets, script, dramaId } = input
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
  const SHOT_X = 1300
  const START_Y = 40
  const ROW_GAP = 280
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

  // 第 1 列：角色
  roleAssets.forEach((asset, index) => {
    const y = START_Y + index * ROW_GAP
    const assetId = String(asset.roleId || asset.assetId || '')
    // 角色：只展示三视图（threeImg），全身图/近身图不处理
    addNode(`role-${assetId}`, 'image', asset.characterName || '角色', { x: COL1_X, y }, {
      roleId: asset.roleId,
      roleName: asset.characterName,
      imageUrl: asset.threeImg,
      referenceView: 'three_view',
      anchorBindings: [{ kind: 'character', entityId: assetId, label: asset.characterName, imageUrl: asset.threeImg }],
      source: 'lens_projection',
      nodeWidth: 384,
      nodeHeight: 250,
      lensTypeLabel: '角色',
      assetCategory: 1,
      entityId: assetId,
      prompt: asset.description || '',
    })
    rememberAssetNode(1, assetId, `role-${assetId}`)
  })

  // 第 2 列：场景（前）+ 道具（后）
  sceneAssets.forEach((asset, index) => {
    const y = START_Y + index * ROW_GAP
    const assetId = String(asset.assetId || '')
    addNode(`scene-${assetId}`, 'image', asset.imgName || '场景', { x: COL2_X, y }, {
      imageUrl: asset.imgUrl,
      anchorBindings: [{ kind: 'scene', entityId: assetId, label: asset.imgName, imageUrl: asset.imgUrl }],
      source: 'lens_projection',
      nodeWidth: 384,
      nodeHeight: 250,
      lensTypeLabel: '场景',
      assetCategory: 2,
      entityId: assetId,
      prompt: asset.description || '',
    })
    rememberAssetNode(2, assetId, `scene-${assetId}`)
  })
  propAssets.forEach((asset, index) => {
    const y = START_Y + (sceneAssets.length + index) * ROW_GAP
    const assetId = String(asset.assetId || '')
    addNode(`prop-${assetId}`, 'image', asset.imgName || '道具', { x: COL2_X, y }, {
      imageUrl: asset.imgUrl,
      anchorBindings: [{ kind: 'prop', entityId: assetId, label: asset.imgName, imageUrl: asset.imgUrl }],
      source: 'lens_projection',
      nodeWidth: 384,
      nodeHeight: 250,
      lensTypeLabel: '道具',
      assetCategory: 3,
      entityId: assetId,
      prompt: asset.description || '',
    })
    rememberAssetNode(3, assetId, `prop-${assetId}`)
  })

  // 2. 剧本/台本文本节点（默认隐藏）：第 2 列道具下方，与道具空出 3 个场景节点高度（250×3）的空间
  const col2Count = sceneAssets.length + propAssets.length
  const lastCol2Y = col2Count > 0 ? START_Y + (col2Count - 1) * ROW_GAP : START_Y - ROW_GAP
  const scriptY = lastCol2Y + 3 * 250
  addNode('script-content', 'text', '剧本原文', { x: COL2_X, y: scriptY }, {
    prompt: script.content || '',
    hidden: true,
    source: 'lens_projection',
    lensTypeLabel: '剧本',
  })
  addNode('script-script-content', 'text', '台本', { x: COL2_X, y: scriptY + ROW_GAP }, {
    prompt: script.scriptContent || '',
    hidden: true,
    source: 'lens_projection',
    lensTypeLabel: '台本',
  })

  // 3. 分镜节点（单个 lensShot 节点，参考生视频；按 storyboardOrder 纵向排列）
  storyboards.forEach((shot, index) => {
    const order = shot.storyboardOrder ?? index + 1
    // 分镜节点 16:9 高 216，纵向间隔 280 避免重叠
    const y = START_Y + index * ROW_GAP
    const shotId = `storyboard-${shot.id}`
    // 该分镜引用的资产（场景/道具/角色/站位），从 assets 按 refId 关联
    const speakerList = String(shot.speakerName || '').split(',').map((s) => s.trim()).filter(Boolean)
    const refs: LensShotRef[] = assets
      .filter((a) => String(a.refId) === String(shot.id))
      .map((a) => {
        const roleName = a.characterName || ''
        return {
          category: a.assetCategory ?? 0,
          id: String(a.roleId || a.assetId || ''),
          name: roleName || a.imgName || '',
          imgUrl: a.threeImg || a.roleImg || a.imgUrl || '',
          isSpeaker: a.assetCategory === 1 && Boolean(roleName) && speakerList.includes(roleName),
        }
      })
    nodes.push({
      id: shotId,
      type: 'lensShot',
      position: { x: SHOT_X, y },
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
  })

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
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadedForRef = useRef<string>('')
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

  /** 保存当前编排（立即，切集前用） */
  const saveNow = useCallback(async (targetEpisode: number, snapshot: { nodes: Node[]; edges: Edge[] }): Promise<boolean> => {
    if (!dramaId) return false
    try {
      const viewport = canvasApiRef.current?.getViewport() ?? { x: 0, y: 0, zoom: 1 }
      const res = await saveFlow(dramaId, targetEpisode, {
        name: `第${targetEpisode}集`,
        data: { nodes: snapshot.nodes, edges: snapshot.edges, viewport, layoutVersion: LAYOUT_VERSION },
        version: flowVersion,
      })
      setFlowVersion((res?.version ?? 0) + 1)
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
    }
  }, [dramaId, flowVersion, setSavedAt])

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
    setLoading(true)
    setError('')
    try {
      // 1. 拉 lens 业务数据
      const [storyboards, assets, script] = await Promise.all([
        listStoryboards(dramaId, targetEpisode),
        getEpisodeAssets(dramaId, targetEpisode),
        getScriptContent(dramaId, targetEpisode),
      ])
      // 2. 投影成节点
      const projected = buildCanvasNodes({ storyboards, assets, script, dramaId })
      lastProjectionRef.current = projected
      // 3. 恢复编排（有 flow 则用 flow 的位置/连线，无则用投影默认布局）
      const flow = await getFlow(dramaId, targetEpisode)
      setFlowVersion(flow?.version ?? 0)
      if (flow?.data) {
        try {
          const parsed = JSON.parse(flow.data) as { nodes?: Node[]; edges?: Edge[]; viewport?: { x: number; y: number; zoom: number }; layoutVersion?: number }
          if (Array.isArray(parsed.nodes) && parsed.nodes.length > 0) {
            // 布局版本不一致：旧 flow 的绝对位置作废，改用最新投影布局（业务字段仍以投影快照为准）
            const useFlowLayout = parsed.layoutVersion === LAYOUT_VERSION
            // 引用模式：flow 里只有编排 + entityId；业务展示字段用最新投影快照覆盖
            const restored = parsed.nodes.map((n) => {
              const fresh = projected.nodes.find((p) => p.id === n.id)
              if (!fresh) return n
              const nData = n.data as Record<string, unknown>
              const freshData = fresh.data as Record<string, unknown>
              // 业务展示字段以最新投影快照为准；引用行开关（showRefs）是编排 UI 状态，以 flow 为准避免被覆盖丢失
              const merged = {
                ...n,
                data: {
                  ...nData,
                  ...freshData,
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
    }
  }, [dramaId, load])

  // 加载集列表（选集下拉）
  useEffect(() => {
    if (!dramaId) { setError('缺少 dramaId 参数'); setLoading(false); return }
    listEpisodes(dramaId).then(setEpisodes).catch(() => setEpisodes([]))
  }, [dramaId])

  // 选集加载
  useEffect(() => { void loadEpisode(episodeNum) }, [episodeNum, loadEpisode])

  // 编排自动保存（debounce 3s）
  useEffect(() => {
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
    if (loading || loadedForRef.current !== `${dramaId}:${episodeNum}`) return
    saveTimerRef.current = setTimeout(() => {
      void saveNow(episodeNum, { nodes: useRFStore.getState().nodes, edges: useRFStore.getState().edges })
    }, 3000)
    return () => {
      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
    }
  }, [nodes, edges, loading, episodeNum, dramaId, saveNow])

  const episodeOptions = episodes.map((e) => ({
    value: String(e.episodeNumber),
    label: `第${e.episodeNumber}集${e.title ? ` · ${e.title}` : ''}`,
  }))

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
          <Switch
            className="lens-canvas-refs-switch"
            size="xs"
            label="引用"
            checked={showRefs}
            onChange={(e) => toggleShowRefs(e.currentTarget.checked)}
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
        <Canvas className="app-canvas" ref={canvasApiRef} arrangeHandler={arrangeLayout} />
      </div>
    </div>
  )
}
