/**
 * Lens 分镜节点（参考生视频）
 *
 * 展示结构（从上到下）：
 * 1. 顶部栏：分镜号（storyboardOrder）+ 时间（timeOfDay）+ 状态圆点（videoStatus/analyzeState/lineArtStatus）
 * 2. 中间区：selectedImageUrl 为空 → 分镜脚本 scriptContent；有值 → 分镜图/视频
 * 3. 底部引用行（showRefs 开关控制）：从左至右 场景、道具、角色、站位；角色带说话者图标（点击切换）
 *
 * 与 tapCanvas 现有 storyboard 节点（分镜图生视频）区分：本节点是「参考图 + 提示词生视频」，
 * 现有 storyboard 节点保留不动。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Handle, Position, NodeToolbar, useReactFlow, type Node, type NodeProps } from '@xyflow/react'
import { ActionIcon, Button, Group, Select, Switch, Text, Textarea, Tooltip, Menu } from '@mantine/core'
import { IconListSearch, IconPlayerPause, IconPlayerPlay, IconX } from '@tabler/icons-react'
import { useRFStore } from '../../canvas/store'
import { useMantineColorScheme } from '@mantine/core'
import { LensReferencePicker } from '../components/LensReferencePicker'
import { connectShotReferences, disconnectShotReference, referenceFromNode, referenceKey } from './lensShotReferences'
import { useUIStore } from '../../ui/uiStore'
import { collectOrderedUpstreamReferenceItems } from './taskNode/upstreamReferences'
import { useModelOptions } from '../../config/useModelOptions'
import { resolveModelGenerationCredits } from '../../config/modelPricing'
import { useCanvasRenderContext } from '../CanvasRenderContext'
import { editStoryboard, clearStoryboardSpeaker, submitShotVideo, type LensAssetEnriched } from '../../api/lens'
import {
  buildDurationOptions,
  clampDuration,
  convergeToOptions,
  resolveModelAspectOptions,
  resolveModelDurationRange,
  resolveModelResolutionOptions,
} from '../utils/lensShotModelParams'

/** 分镜引用（底部引用行）：场景/道具/角色/站位 */
export interface LensShotRef {
  /** 1=角色 2=场景 3=道具 4=站位 */
  category: number
  id: string
  /** 完整显示名：子角色为「方怡静（连衣裙）」，子场景为「街道（夜晚）」 */
  name: string
  imgUrl?: string
  /**
   * 基础名，仅角色使用：主角色即自身名称，子角色取父角色名。
   *
   * 写入 lens 的 speakerName 必须是基础名（与分镜板 toggleSpeaker 一致），
   * 不能用带造型后缀的完整名。缺失时回退到 name。
   */
  baseName?: string
  /** 是否说话者（speakerName 匹配） */
  isSpeaker?: boolean
}

/** 分镜节点数据 */
export interface LensShotNodeData extends Record<string, unknown> {
  label?: string
  storyboardOrder?: number
  timeOfDay?: string
  /** 分镜时长（秒） */
  time?: number
  scriptContent?: string
  selectedImageUrl?: string
  /** 0=图 1=视频 */
  selectFileType?: number
  /** 0未生成 1生成中 2成功 3失败 4智能分析中 */
  videoStatus?: number
  /** 0未分析 1分析中 2成功 3失败 */
  analyzeState?: number
  /** 0未处理 1生成中 2成功 3失败 */
  lineArtStatus?: number
  /** 说话者（逗号分隔的角色名） */
  speakerName?: string
  /** 该分镜引用的资产（场景/道具/角色/站位） */
  refs?: LensShotRef[]
  /** 是否展示底部引用行（画布顶部开关控制） */
  showRefs?: boolean
  entityId?: string
  sourceProjectId?: string
}

/** lens 分镜节点的 React Flow 节点类型（Node<data, type>） */
export type LensShotNodeType = Node<LensShotNodeData, 'lensShot'>

/** 状态常量（对齐 lens SceneShotCard） */
const VIDEO_STATUS_SUCCESS = 2
const ANALYZE_STATE_PROCESSING = 1
const ANALYZE_STATE_FAILED = 3
const LINE_ART_STATUS_PROCESSING = 1
const LINE_ART_STATUS_FAILED = 3

/** 秒数格式化：<60 显示 "8s"，>=60 显示 "1分12s" */
function formatSeconds(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}分${s % 60}s`
}

/** 引用类别顺序：场景、道具、角色、站位 */
const REF_ORDER: Record<number, number> = { 2: 0, 3: 1, 1: 2, 4: 3 }
const REF_LABEL: Record<number, string> = { 1: '角色', 2: '场景', 3: '道具', 4: '站位' }

/** OSS 缩略图：小图展示追加 x-oss-process 缩放参数（与 lens 前端口径一致，避免拉原图） */
function ossThumb(url: string | undefined, width = 100): string {
  if (!url) return ''
  if (url.startsWith('data:') || url.startsWith('blob:')) return url
  if (url.includes('x-oss-process')) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}x-oss-process=image/resize,w_${width}`
}

/** 状态圆点（对齐 lens 分镜板：淡黄呼吸=生成中、绿点=成功、红点=失败、呼吸光圈=分析/线稿中） */
function StatusDot({ data }: { data: LensShotNodeData }): JSX.Element {
  const videoStatus = data.videoStatus ?? 0
  const analyzeState = data.analyzeState ?? 0
  const lineArtStatus = data.lineArtStatus ?? 0

  const generating = videoStatus === 1 || videoStatus === 4
  const success = videoStatus === VIDEO_STATUS_SUCCESS
  const failed = videoStatus === 3

  if (generating) {
    return (
      <span className="lens-shot-status-dot lens-shot-status-dot--generating" title="生成中" />
    )
  }
  if (failed) {
    return <span className="lens-shot-status-dot lens-shot-status-dot--failed" title="失败" />
  }
  if (success) {
    return (
      <span className="lens-shot-status-dot lens-shot-status-dot--success" title="成功">
        {analyzeState === ANALYZE_STATE_PROCESSING && <i className="lens-shot-status-ring lens-shot-status-ring--analyze" />}
        {lineArtStatus === LINE_ART_STATUS_PROCESSING && <i className="lens-shot-status-ring lens-shot-status-ring--lineart" />}
        {(analyzeState === ANALYZE_STATE_FAILED || lineArtStatus === LINE_ART_STATUS_FAILED) && <i className="lens-shot-status-ring lens-shot-status-ring--failed" />}
      </span>
    )
  }
  return <span className="lens-shot-status-dot lens-shot-status-dot--idle" title="未生成" />
}

/**
 * 由资产快照构造分镜引用。
 *
 * 快照里的 characterName/imgName 已由后端拼好子角色「方怡静（连衣裙）」、
 * 子场景「街道（夜晚）」等完整名称，这里直接作为 name 展示；
 * 说话者必须使用基础名，与分镜板 toggleSpeaker 写入的口径一致。
 */
export function buildShotRefsFromAssets(
  assets: LensAssetEnriched[],
  shotId: string,
  speakerList: string[],
): LensShotRef[] {
  return assets
    .filter((asset) => String(asset.refId) === String(shotId))
    .map((asset) => {
      const displayName = asset.characterName || asset.imgName || ''
      // 子角色取父角色名作为基础名；主角色基础名即自身名称。
      const roleBaseName = asset.assetCategory === 1
        ? (asset.parentId ? displayName.replace(/[（(].*?[）)]$/, '').trim() : displayName)
        : ''
      return {
        category: asset.assetCategory ?? 0,
        id: String(asset.roleId || asset.assetId || ''),
        name: displayName,
        imgUrl: asset.threeImg || asset.roleImg || asset.imgUrl || '',
        ...(roleBaseName ? { baseName: roleBaseName } : null),
        isSpeaker: asset.assetCategory === 1 && Boolean(roleBaseName) && speakerList.includes(roleBaseName),
      }
    })
}

/** 说话者切换：点击角色引用上的说话图标，切换 speakerName 并写回 lens */
function toggleSpeaker(nodeId: string, data: LensShotNodeData, roleName: string): void {
  const store = useRFStore.getState()
  const dramaId = String(data.sourceProjectId || '')
  const shotId = String(data.entityId || '')
  if (!shotId) return

  const current = String(data.speakerName || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const next = current.includes(roleName)
    ? current.filter((s) => s !== roleName)
    : [...current, roleName]
  const nextSpeakerName = next.join(',')

  // 更新节点显示（乐观更新）
  store.updateNodeData(nodeId, {
    speakerName: nextSpeakerName || undefined,
    refs: Array.isArray(data.refs)
      ? data.refs.map((r) => (r.category === 1 && (r.baseName || r.name) === roleName ? { ...r, isSpeaker: next.includes(roleName) } : r))
      : [],
  })

  // 写回 lens（与 lens 分镜板 toggleSpeaker 一致：有说话者走 edit，清空走 clearSpeakerName）
  if (next.length > 0) {
    editStoryboard({ id: shotId, dramaId, speakerName: nextSpeakerName }).catch(() => undefined)
  } else {
    clearStoryboardSpeaker(shotId, dramaId).catch(() => undefined)
  }
}

function LensShotNode({ id, data, selected }: NodeProps<LensShotNodeType>): JSX.Element {
  // 任务结果抽屉的入口回调（由 LensCanvasApp 注入；未注入则不显示按钮）
  const { onOpenTaskResult } = useCanvasRenderContext()
  const { colorScheme } = useMantineColorScheme()
  const isDark = colorScheme === 'dark'
  const rf = useReactFlow()
  const [assetPickerOpened, setAssetPickerOpened] = useState(false)
  const openCanvasPicker = useCallback(() => {
    const store = useRFStore.getState()
    useUIStore.getState().openCanvasReferencePicker({ targetNodeId: id,
      blockedSourceNodeIds: store.edges.filter((edge) => edge.target === id).map((edge) => edge.source),
      onSelect: async (sourceId) => {
        const source = useRFStore.getState().nodes.find((node) => node.id === sourceId)
        if (!source) throw new Error('参考节点已不存在')
        await connectShotReferences(id, [referenceFromNode(source)], sourceId)
      },
    })
  }, [id])
  useEffect(() => () => {
    if (useUIStore.getState().canvasReferencePicker?.targetNodeId === id) useUIStore.getState().closeCanvasReferencePicker()
  }, [id])
  // 自绘视频控制（去掉原生 controls，避免双击原生全屏；双击节点=放大到该节点）
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [isPlaying, setIsPlaying] = useState<boolean>(false)
  const [currentSec, setCurrentSec] = useState<number>(0)
  const [durationSec, setDurationSec] = useState<number>(0)
  const showRefs = Boolean(data.showRefs)
  const hasResult = Boolean(data.selectedImageUrl && String(data.selectedImageUrl).trim())
  // 分镜时长（秒）：优先 lens 分镜 time 字段，有视频时用视频实际时长
  const [mediaSeconds, setMediaSeconds] = useState<number | null>(typeof data.time === 'number' && data.time > 0 ? data.time : null)
  // lens 模式下 useModelOptions('video') 走 /api/model/shot_video（分镜生视频模型）
  const models = useModelOptions('video')
  // 编辑区草稿（选中展开时显示，保存时写回节点 + 同步分镜板）
  const [scriptDraft, setScriptDraft] = useState<string>(String(data.scriptContent ?? ''))
  const [timeDraft, setTimeDraft] = useState<string>(String(data.timeOfDay ?? ''))
  const [modelValue, setModelValue] = useState<string | null>(typeof data.model === 'string' && data.model ? data.model : null)
  const [saveState, setSaveState] = useState<string>('')
  // 编辑模式：prompt=分镜提示词（默认展示），script=分镜剧本
  const [promptMode, setPromptMode] = useState<'script' | 'prompt'>('prompt')
  const [promptDraft, setPromptDraft] = useState<string>(String(data.prompt ?? ''))
  // 画幅 / 分辨率（生成参数，随节点持久化）
  const [aspectValue, setAspectValue] = useState<string>(String(data.aspectRatio ?? '16:9'))
  const [resolutionValue, setResolutionValue] = useState<string>(String(data.resolution ?? '1080p'))
  const selectedModel = models.find((m) => m.value === modelValue)
  // 生成时长 / 画幅 / 分辨率：全部随所选模型的能力配置联动（解析逻辑见 lensShotModelParams）
  const [durationValue, setDurationValue] = useState<number | null>(
    typeof data.time === 'number' && data.time > 0 ? Math.trunc(data.time) : null,
  )
  const { min: minDuration, max: maxDuration } = resolveModelDurationRange(selectedModel?.meta)
  const durationOptions = useMemo(() => buildDurationOptions(minDuration, maxDuration), [minDuration, maxDuration])
  const aspectOptions = useMemo(() => resolveModelAspectOptions(selectedModel?.meta), [selectedModel])
  const resolutionOptions = useMemo(() => resolveModelResolutionOptions(selectedModel?.meta), [selectedModel])
  // 与提交使用相同的生成时长，报价来自后端计费器；不把价格保存到 flow。
  const consumePoints = useMemo(() => selectedModel
    ? resolveModelGenerationCredits({
        kind: 'video',
        modelOption: selectedModel,
        specValues: { resolution: resolutionValue },
        durationSeconds: clampDuration(durationValue, minDuration, maxDuration),
      })
    : null, [selectedModel, resolutionValue, durationValue, minDuration, maxDuration])
  // 换模型后若当前时长超出该模型区间，收敛到边界值（避免下发超限时长被渠道拒绝）
  useEffect(() => {
    setDurationValue((prev) => clampDuration(prev, minDuration, maxDuration))
  }, [minDuration, maxDuration])

  // 换模型后若当前画幅/分辨率不在该模型支持范围内，收敛到该模型允许的值
  // （避免下发模型不支持的画幅/分辨率，被渠道直接拒绝或按默认值静默改写）
  // 依赖里同时带上节点持久化值：切集/刷新后 data.aspectRatio 变化时重新按当前模型收敛
  useEffect(() => {
    const persisted = typeof data.aspectRatio === 'string' && data.aspectRatio ? data.aspectRatio : null
    setAspectValue((prev) => convergeToOptions(persisted ?? prev, aspectOptions) ?? prev)
  }, [aspectOptions, data.aspectRatio])
  useEffect(() => {
    const persisted = typeof data.resolution === 'string' && data.resolution ? data.resolution : null
    setResolutionValue((prev) => convergeToOptions(persisted ?? prev, resolutionOptions) ?? prev)
  }, [resolutionOptions, data.resolution])

  // 媒体实际宽高比（用于节点高度随视频比例：宽度恒 384 填满，高度按比例）
  const [mediaAspect, setMediaAspect] = useState<number | null>(null)

  // 换媒体时重置比例与时长，等新图/视频加载后重新计算
  useEffect(() => {
    setMediaAspect(null)
    setMediaSeconds(typeof data.time === 'number' && data.time > 0 ? data.time : null)
  }, [data.selectedImageUrl, data.time])

  // 节点数据变化时回填编辑草稿（如切集/刷新后）
  // 注意：画幅/分辨率/时长不在此回填 —— 它们必须跟随所选模型的可用范围（见上方收敛 effect），
  // 若在这里按 data.* 覆盖，会在切模型时把已收敛到模型范围内的值又改回越界值。
  useEffect(() => {
    setScriptDraft(String(data.scriptContent ?? ''))
    setTimeDraft(String(data.timeOfDay ?? ''))
    setModelValue(typeof data.model === 'string' && data.model ? data.model : null)
    setPromptDraft(String(data.prompt ?? ''))
  }, [data.scriptContent, data.timeOfDay, data.model, data.prompt])

  /** 聚焦或播放当前视频时，暂停同一画布的其他视频，保留其播放进度。 */
  const pauseOtherVideos = useCallback(() => {
    const current = videoRef.current
    const canvas = current?.closest('.react-flow')
    if (!current || !canvas) return
    canvas.querySelectorAll<HTMLVideoElement>('video').forEach((video) => {
      if (video !== current && !video.paused) video.pause()
    })
  }, [])

  /** 播放当前视频，播放失败时保留真实状态并显示原因。 */
  const playCurrentVideo = useCallback(() => {
    const video = videoRef.current
    if (!video || !video.paused) return
    void video.play().catch((error: unknown) => {
      setIsPlaying(!video.paused)
      setSaveState(`视频播放失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }, [])

  /** 双击聚焦并播放当前视频，不进入浏览器全屏。 */
  const zoomToSelf = useCallback((e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault()
      e.stopPropagation()
    }
    pauseOtherVideos()
    playCurrentVideo()
    const node = rf.getNode(id)
    if (!node) return
    const w = Number(node?.measured?.width ?? node?.width ?? 400)
    const h = Number(node?.measured?.height ?? node?.height ?? 300)
    // 分镜组内节点的 position 是相对组坐标：累加父链得到绝对坐标，否则放大位置对不上
    const storeNodes = useRFStore.getState().nodes
    const byId = new Map(storeNodes.map((n) => [n.id, n] as const))
    let absX = Number(node.position.x ?? 0)
    let absY = Number(node.position.y ?? 0)
    let parentId = (node as unknown as { parentId?: string }).parentId
    while (parentId) {
      const parent = byId.get(parentId)
      if (!parent) break
      absX += Number(parent.position.x ?? 0)
      absY += Number(parent.position.y ?? 0)
      parentId = (parent as unknown as { parentId?: string }).parentId
    }
    rf.setCenter(absX + w / 2, absY + h / 2, { zoom: 1.2, duration: 250 })
  }, [rf, id, pauseOtherVideos, playCurrentVideo])

  /** 播放/暂停切换 */
  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) { playCurrentVideo() } else { v.pause(); setIsPlaying(false) }
  }, [playCurrentVideo])

  /** 秒数格式化（控制条时间） */
  const formatClock = useCallback((sec: number): string => {
    const s = Math.max(0, Math.floor(sec))
    const m = Math.floor(s / 60)
    return `${m}:${String(s % 60).padStart(2, '0')}`
  }, [])

  // 引用行：按 场景→道具→角色→站位 排序（定义在 handleGenerate 之前，避免 TDZ）
  const refs = (Array.isArray(data.refs) ? [...data.refs] : []).sort(
    (a, b) => (REF_ORDER[a.category] ?? 9) - (REF_ORDER[b.category] ?? 9),
  )

  const handleSave = useCallback(async () => {
    useRFStore.getState().updateNodeData(id, { scriptContent: scriptDraft, timeOfDay: timeDraft, model: modelValue })
    const storyboardId = String(data.entityId ?? '')
    const dramaId = String(data.sourceProjectId ?? '')
    if (storyboardId && dramaId) {
      try {
        await editStoryboard({ id: storyboardId, dramaId, scriptContent: scriptDraft, timeOfDay: timeDraft })
        setSaveState('已同步到分镜板')
      } catch (err) {
        setSaveState(`同步失败：${err instanceof Error ? err.message : '未知错误'}`)
      }
    }
  }, [id, data.entityId, data.sourceProjectId, scriptDraft, timeDraft, modelValue])

  /** 提交分镜生视频任务（走 lens /api/storyboardTask/submit，与分镜板一致） */
  const handleGenerate = useCallback(async () => {
    const storyboardId = String(data.entityId ?? '')
    const dramaId = String(data.sourceProjectId ?? '')
    if (!storyboardId || !dramaId) return
    if (!modelValue) {
      setSaveState('请先选择生视频模型')
      return
    }
    // 时长：按秒/按时长计费模型的必填参数，缺失时后端 /api/storyboardTask/submit
    // 会在余额预检抛「参数错误，缺少时长」，任务根本无法落库。
    // 取节点上显式选择的时长（默认回填分镜自身时长），并夹到所选模型的 min~max 区间内。
    const duration = clampDuration(durationValue, minDuration, maxDuration)
    if (duration === null) {
      setSaveState('请先选择生成时长')
      return
    }
    setSaveState('任务提交中…')
    try {
      await submitShotVideo({
        dramaId,
        episodeNum: Number(data.episodeNum ?? 1),
        storyboardId,
        model: modelValue,
        appid: Number(modelValue) || undefined,
        prompt: promptDraft || scriptDraft,
        aspectRatio: aspectValue,
        resolution: resolutionValue,
        duration,
        refImages: JSON.stringify(Array.from(new Set([
          ...refs.map((ref) => ref.imgUrl).filter(Boolean),
          ...collectOrderedUpstreamReferenceItems(useRFStore.getState().nodes, useRFStore.getState().edges, id).map((item) => item.previewUrl),
        ]))),
      })
      setSaveState('已提交生视频任务')
    } catch (err) {
      setSaveState(`提交失败：${err instanceof Error ? err.message : '未知错误'}`)
    }
  }, [data.entityId, data.sourceProjectId, data.episodeNum, data.prompt, scriptDraft, modelValue, refs, aspectValue, resolutionValue, durationValue, minDuration, maxDuration])

  // 横屏：宽 800、高按比例（16:9→450）；竖屏：高度限制 720、宽度随高度收窄（9:16→720×405），视频完整不裁切
  const HEADER_HEIGHT = 44
  const REFS_BAR_HEIGHT = 38
  const VERTICAL_MAX_HEIGHT = 720
  const mediaHeight = mediaAspect
    ? Math.max(96, mediaAspect >= 1 ? Math.round(800 / mediaAspect) : Math.min(VERTICAL_MAX_HEIGHT, Math.round(800 / mediaAspect)))
    : 450
  const shellWidth = mediaAspect && mediaAspect < 1 ? Math.round(mediaHeight * mediaAspect) : 800

  // 媒体尺寸确定后节点高度会变化：若该分镜在组合框内，多次补适配组框高度
  // （刷新时媒体加载可能晚于首次适配，多时机重试避免视频超出组合框）
  useEffect(() => {
    const fitParentGroup = () => {
      const parentId = useRFStore.getState().nodes.find((n) => n.id === id)?.parentId
      if (parentId) useRFStore.getState().fitGroupToChildren(parentId)
    }
    const timers = [160, 500, 1200].map((delay) => window.setTimeout(fitParentGroup, delay))
    return () => timers.forEach((t) => window.clearTimeout(t))
  }, [id, mediaHeight, mediaAspect])
  const shellHeight = mediaHeight + HEADER_HEIGHT + (showRefs && refs.length > 0 ? REFS_BAR_HEIGHT : 0)

  const shell = {
    background: isDark ? 'rgba(15,20,28,0.96)' : 'rgba(255,255,255,0.98)',
    border: selected ? '1px solid #5b8def' : isDark ? '1px solid rgba(255,255,255,0.06)' : '1px solid rgba(15,23,42,0.08)',
    boxShadow: selected ? '0 0 0 3px rgba(91,141,239,0.25), 0 8px 24px rgba(0,0,0,0.12)' : '0 4px 16px rgba(0,0,0,0.08)',
    color: isDark ? '#f0f0f0' : '#1d2129',
    borderRadius: 12,
    // 宽度固定 384、高度随视频比例（+顶部栏/引用行高）；relative 供底部悬浮引用行定位
    width: shellWidth,
    height: shellHeight,
    position: 'relative' as const,
    display: 'flex' as const,
    flexDirection: 'column' as const,
    overflow: 'hidden' as const,
  }

  return (
    <div className="tc-task-node lens-shot-node" style={shell}>
      <Handle className="lens-shot-handle" type="target" position={Position.Left} />
      <Handle className="lens-shot-handle" type="source" position={Position.Right} />

      {/* 顶部栏：分镜号 + 时长（紧跟序号左侧）+ 状态圆点（不显示 timeOfDay，时长取分镜 time 字段或视频实际时长） */}
      <div className="lens-shot-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 44, padding: '0 12px', borderBottom: '1px solid rgba(127,127,127,0.18)', fontSize: 30, fontWeight: 600, lineHeight: 1 }}>
        <span className="lens-shot-order" style={{ display: 'inline-flex', alignItems: 'baseline' }}>
          分镜{data.storyboardOrder ?? '-'}
          {mediaSeconds != null && (
            <span className="lens-shot-duration" style={{ fontWeight: 600, marginLeft: 14, fontSize: 22, color: '#8ab4ff', background: 'rgba(91,141,239,0.16)', padding: '1px 9px', borderRadius: 999, lineHeight: 1.2 }}>
              {formatSeconds(mediaSeconds)}
            </span>
          )}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {/* 任务结果入口：只读查看该分镜的历史生视频任务（懒加载，点开才查） */}
          {onOpenTaskResult && (
            <Tooltip label="任务结果" position="top" withArrow>
              <ActionIcon
                className="lens-shot-task-result-btn"
                variant="subtle"
                size="sm"
                aria-label="任务结果"
                onClick={(e) => {
                  e.stopPropagation()
                  onOpenTaskResult(id)
                }}
              >
                <IconListSearch size={16} />
              </ActionIcon>
            </Tooltip>
          )}
          <StatusDot data={data} />
        </span>
      </div>

      {/* 中间区：图/视频 或 脚本（占满剩余空间，媒体按实际宽高比自适应节点宽度） */}
      <div className="lens-shot-body" style={{ flex: 1, minHeight: 0, padding: 8, overflow: 'hidden' }}>
        {hasResult ? (
          data.selectFileType === 1 ? (
            <div className="lens-shot-video-wrap" style={{ position: 'relative', width: '100%', height: '100%' }}>
              <video
                ref={videoRef}
                className="lens-shot-media"
                src={data.selectedImageUrl}
                preload="metadata"
                onClick={togglePlay}
                onDoubleClickCapture={(e) => {
                  // 双击视频：放大到该节点（无原生 controls，不会触发浏览器全屏）
                  zoomToSelf(e)
                }}
                onPlay={() => { pauseOtherVideos(); setIsPlaying(true) }}
                onPause={() => setIsPlaying(false)}
                onTimeUpdate={(e) => setCurrentSec(e.currentTarget.currentTime)}
                onLoadedMetadata={(e) => {
                  const v = e.currentTarget
                  if (v.videoWidth > 0 && v.videoHeight > 0) {
                    setMediaAspect(v.videoWidth / v.videoHeight)
                  }
                  if (Number.isFinite(v.duration) && v.duration > 0) {
                    setMediaSeconds(Math.round(v.duration))
                    setDurationSec(v.duration)
                  }
                }}
                style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 6, display: 'block', background: 'rgba(0,0,0,0.35)' }}
              />
              {/* 自绘视频控制条：播放/暂停 + 进度 + 时间（替代原生 controls，避免双击全屏） */}
              <div
                className="lens-shot-video-controls"
                style={{ position: 'absolute', left: 6, right: 6, bottom: 6, display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', borderRadius: 8, background: 'rgba(10,14,20,0.66)', backdropFilter: 'blur(8px)', zIndex: 2 }}
                onDoubleClick={(e) => { e.stopPropagation(); zoomToSelf(e) }}
              >
                <Tooltip label={isPlaying ? '暂停' : '播放'} position="top" withArrow>
                  <span
                    className="lens-shot-video-toggle"
                    onClick={(e) => { e.stopPropagation(); togglePlay() }}
                    style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 999, background: 'rgba(255,255,255,0.14)', color: '#fff', cursor: 'pointer', flexShrink: 0 }}
                  >
                    {isPlaying ? <IconPlayerPause size={14} /> : <IconPlayerPlay size={14} />}
                  </span>
                </Tooltip>
                <input
                  className="lens-shot-video-progress"
                  type="range"
                  min={0}
                  max={durationSec || 0}
                  step={0.1}
                  value={currentSec}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    const v = videoRef.current
                    const next = Number(e.currentTarget.value)
                    if (v) { v.currentTime = next }
                    setCurrentSec(next)
                  }}
                  style={{ flex: 1, minWidth: 0, accentColor: '#60a5fa' }}
                />
                <Text size="xs" style={{ color: 'rgba(255,255,255,0.85)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                  {formatClock(currentSec)} / {formatClock(durationSec || mediaSeconds || 0)}
                </Text>
              </div>
            </div>
          ) : (
            <img
              className="lens-shot-media"
              src={data.selectedImageUrl}
              alt="分镜图"

              style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 6, display: 'block' }}
              onLoad={(e) => {
                const img = e.currentTarget
                if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                  setMediaAspect(img.naturalWidth / img.naturalHeight)
                }
              }}
            />
          )
        ) : (
          <div className="lens-shot-script" style={{ fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', height: '100%', overflow: 'auto' }}>
            {data.scriptContent || '（暂无脚本）'}
          </div>
        )}

      </div>
      {/* 底部引用行：场景/道具/角色/站位（画布顶部「引用」开关控制，作为节点底部独立一行，不悬浮不遮挡媒体内容） */}
      {showRefs && refs.length > 0 && (
        <div className="lens-shot-refs" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', borderTop: '1px solid rgba(127,127,127,0.16)', flexWrap: 'wrap', flexShrink: 0 }}>
          {refs.map((ref) => (
            <Tooltip key={`${ref.category}-${ref.id}`} label={ref.name} position="top" withArrow>
              <span className="lens-shot-ref" style={{ position: 'relative', display: 'inline-flex', cursor: ref.category === 1 ? 'pointer' : 'default' }}>
                {ref.imgUrl ? (
                  <img className="lens-shot-ref-img" src={ossThumb(ref.imgUrl)} alt={ref.name} style={{ width: 30, height: 30, objectFit: 'cover', borderRadius: 4, border: '1px solid rgba(127,127,127,0.2)' }} />
                ) : (
                  <span className="lens-shot-ref-empty" style={{ width: 30, height: 30, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, border: '1px solid rgba(127,127,127,0.2)', fontSize: 10, opacity: 0.7 }}>{ref.name.slice(0, 1)}</span>
                )}
                {ref.category === 1 && (
                  <span
                    className={`lens-shot-speaker ${ref.isSpeaker ? 'is-speaker' : ''}`}
                    onClick={(e) => { e.stopPropagation(); toggleSpeaker(id, data, ref.baseName || ref.name) }}
                    title={ref.isSpeaker ? '取消说话者' : '设为说话者'}
                    style={{
                      position: 'absolute', right: -4, top: -4, width: 14, height: 14, borderRadius: '50%',
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      background: ref.isSpeaker ? '#22c55e' : 'rgba(127,127,127,0.45)', color: '#fff',
                      fontSize: 9, boxShadow: '0 0 0 1.5px rgba(255,255,255,0.85)',
                    }}
                  >
                    🎤
                  </span>
                )}
              </span>
            </Tooltip>
          ))}
        </div>
      )}
      {/* 选中时节点下方浮出编辑面板（框架对齐角色节点原生弹窗：tc-task-node__toolbar-frame，固定 100% 不随画布缩放） */}
      {selected && (
        <NodeToolbar className="lens-shot-edit-toolbar" position={Position.Bottom} align="center">
          <div
            className="tc-task-node__toolbar-frame tc-task-node__toolbar-frame--media"
            data-no-node-dblclick="1"
            onDoubleClick={(e) => {
              // 阻止双击冒泡到画布节点（快速切换开关会被识别为双击→聚焦）
              e.stopPropagation()
            }}
            onWheelCapture={(e) => {
              // 弹窗区域内滚轮不触发画布缩放（内部可滚动元素自行滚动）
              e.stopPropagation()
            }}
            style={{
              position: 'relative',
              zIndex: 3001,
              width: 'min(800px, calc((100vw - 48px)))',
              // 面板随内容完整展开；只有下方编辑框承载长文本滚动。
              overflow: 'visible',
              transformOrigin: 'top center',
              transform: 'scale(1)',
            }}
          >
            <div className="tc-task-node__toolbar-content tc-task-node__toolbar-content--media">
              {/* 弹窗标题行：左侧「上游参考」，中间「分镜#N」真正居中（三列 grid：1fr auto 1fr） */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', marginBottom: 10 }}>
                <Text size="xs" fw={600} c="dimmed" style={{ letterSpacing: 0.4, whiteSpace: 'nowrap' }}>上游参考</Text>
                <Text size="md" fw={700} style={{ textAlign: 'center', letterSpacing: 0.5, whiteSpace: 'nowrap' }}>分镜#{data.storyboardOrder ?? '-'}</Text>
                {/* 与标题同一行，固定在编辑工具栏右上角。 */}
                <Group className="lens-shot-task-toolbar-actions" justify="flex-end" wrap="nowrap">
                  {onOpenTaskResult && (
                    <Button
                      className="lens-shot-task-results nodrag nopan"
                      size="compact-xs" variant="subtle" color="gray"
                      leftSection={<IconListSearch className="lens-shot-task-results-icon" size={14} />}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => { event.stopPropagation(); onOpenTaskResult(id) }}
                    >任务结果</Button>
                  )}
                </Group>
              </div>

              {/* 上游参考：缩略图 + 添加按钮（卡片化缩略图，右上角类型胶囊） */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 2 }}>
                {refs.length > 0 ? refs.map((ref) => (
                  <Tooltip key={`${ref.category}-${ref.id}`} label={ref.name} position="top" withArrow>
                    <span className="lens-shot-toolbar-reference" style={{ position: 'relative', display: 'inline-flex', cursor: 'grab' }}>
                      {ref.imgUrl ? (
                        <img src={ossThumb(ref.imgUrl)} alt={ref.name} style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 10, border: '1px solid rgba(127,127,127,0.18)' }} />
                      ) : (
                        <span style={{ width: 44, height: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 10, border: '1px solid rgba(127,127,127,0.18)', fontSize: 10, opacity: 0.7 }}>{ref.name.slice(0, 1)}</span>
                      )}
                      <span style={{ position: 'absolute', left: 3, bottom: 3, fontSize: 9, lineHeight: 1, padding: '2px 5px', borderRadius: 999, background: 'rgba(10,14,20,0.72)', color: 'rgba(255,255,255,0.85)', backdropFilter: 'blur(4px)' }}>{REF_LABEL[ref.category] ?? '引'}</span>
                      <ActionIcon className="lens-shot-toolbar-reference-remove nodrag nopan" size={18} variant="filled" color="dark" aria-label={`删除 ${ref.name} 引用及连线`} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); void disconnectShotReference(id, ref).catch((error: unknown) => setSaveState(`删除参考失败：${error instanceof Error ? error.message : String(error)}`)) }}><IconX size={12} stroke={2.5} /></ActionIcon>
                    </span>
                  </Tooltip>
                )) : (
                  <Text size="xs" c="dimmed">暂无引用资产</Text>
                )}
                <Menu trigger="click-hover" openDelay={100} closeDelay={180} withinPortal zIndex={3500}>
                  <Menu.Target><ActionIcon className="lens-shot-reference-add nodrag nopan" variant="subtle" size={44} aria-label="添加参考">+</ActionIcon></Menu.Target>
                  <Menu.Dropdown className="lens-shot-reference-menu nodrag nopan">
                    <Menu.Item className="lens-shot-reference-menu__canvas" onClick={openCanvasPicker}>从画布选择参考</Menu.Item>
                    <Menu.Item className="lens-shot-reference-menu__library" onClick={() => { useUIStore.getState().closeCanvasReferencePicker(); setAssetPickerOpened(true) }}>从资产库选择参考</Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              </div>

              {/* 编辑区：时间/模型 参数行 + 剧本 / 提示词 切换（默认剧本；提示词为分镜生视频提示词 data.prompt） */}
              <Group justify="space-between" align="center" mb={6} style={{ marginTop: 10 }}>
                <Group gap={8} align="center" wrap="nowrap">
                  <Text size="sm" fw={600}>{promptMode === 'prompt' ? '分镜提示词' : '分镜剧本'}</Text>
                  {/* 时长：选项范围随所选模型配置（minDuration~maxDuration），与分镜板分镜任务面板一致 */}
                  <Select
                    size="xs"
                    w={78}
                    data={durationOptions}
                    value={durationValue === null ? null : String(durationValue)}
                    onChange={(v) => {
                      const next = v === null ? null : Number(v)
                      const durationNext = next !== null && Number.isFinite(next) ? Math.trunc(next) : null
                      setDurationValue(durationNext)
                      // 同步写回节点数据 + 分镜板（/api/storyboard/edit，与分镜板面板 saveStoryboardTime 同一出口）
                      useRFStore.getState().updateNodeData(id, { time: durationNext })
                      const storyboardId = String(data.entityId ?? '')
                      const dramaId = String(data.sourceProjectId ?? '')
                      if (durationNext !== null && storyboardId && dramaId) {
                        void editStoryboard({ id: storyboardId, dramaId, time: durationNext }).catch((err: unknown) => {
                          setSaveState(`时长同步失败：${err instanceof Error ? err.message : '未知错误'}`)
                        })
                      }
                    }}
                    placeholder="时长"
                    aria-label="生成时长"
                  />
                </Group>
                <Group className="lens-shot-prompt-header-actions" gap={8} align="center" justify="flex-end" wrap="nowrap">
                  <Button className="lens-shot-save-storyboard" size="xs" variant="outline" onClick={() => void handleSave()}>保存到分镜板</Button>
                  <Switch
                    className="lens-shot-prompt-mode-switch"
                    size="xs"
                    label="提示词"
                    checked={promptMode === 'prompt'}
                    onChange={(e) => setPromptMode(e.currentTarget.checked ? 'prompt' : 'script')}
                  />
                </Group>
              </Group>
              {/* 两种内容共用固定高度，避免切换到长提示词时撑出工具栏滚动条。 */}
              <Textarea
                className="lens-shot-prompt-editor"
                size="sm"
                rows={7}
                value={promptMode === 'prompt' ? promptDraft : scriptDraft}
                onChange={(e) => {
                  const next = e.currentTarget.value
                  if (promptMode === 'prompt') setPromptDraft(next)
                  else setScriptDraft(next)
                }}
                placeholder={promptMode === 'prompt' ? '分镜提示词（生视频用，可为 JSON）' : '分镜剧本（含动作与对白）'}
                mb={12}
              />

              {/* 底部控制栏：模型 + 画幅 + 分辨率 + 积分 + 生成；保存位于上方提示词开关前。 */}
              <div className="tc-task-node__toolbar-controls--footer tc-task-node__toolbar-controls--media-footer">
                <Group gap={8} align="flex-end" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
                  <Select
                    size="xs"
                    searchable
                    clearable
                    style={{ flex: 1, minWidth: 0 }}
                    data={models.map((m) => ({ value: m.value, label: m.label, disabled: m.disabled }))}
                    value={modelValue}
                    onChange={(v) => setModelValue(v)}
                    placeholder={models.length ? '选择生视频模型' : '暂无可用模型'}
                  />
                  {/* 画幅：选项来自所选模型 others.supportedRatios，未配置时用通用兜底 */}
                  <Select
                    size="xs"
                    w={92}
                    data={aspectOptions.map((v) => ({ value: v, label: v }))}
                    value={aspectValue}
                    onChange={(v) => setAspectValue(v ?? aspectValue)}
                    aria-label="画幅"
                  />
                  {/* 分辨率：选项来自所选模型 resolutions，未配置时用通用兜底 */}
                  <Select
                    size="xs"
                    w={92}
                    data={resolutionOptions.map((v) => ({ value: v, label: v }))}
                    value={resolutionValue}
                    onChange={(v) => setResolutionValue(v ?? resolutionValue)}
                    aria-label="分辨率"
                  />
                  <Text size="xs" fw={600} style={{ whiteSpace: 'nowrap', padding: '3px 9px', borderRadius: 999, background: 'rgba(127,127,127,0.12)' }}>{consumePoints === null ? '积分未配置' : `${consumePoints} 积分`}</Text>
                  <Button size="xs" variant="filled" onClick={() => void handleGenerate()}>生成</Button>
                </Group>
              </div>
              {saveState && <Text size="xs" c="dimmed" mt={8} style={{ textAlign: 'right' }}>{saveState}</Text>}
            </div>
          </div>
        </NodeToolbar>
      )}

      <LensReferencePicker opened={assetPickerOpened} dramaId={String(data.sourceProjectId || '')} existingKeys={(data.refs || []).map(referenceKey)} onClose={() => setAssetPickerOpened(false)} onConfirm={(assets) => connectShotReferences(id, assets)} />
    </div>
  )
}

export default memo(LensShotNode)
