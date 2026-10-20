/**
 * Lens 分镜视频节点（参考生视频）
 *
 * <p>视觉与交互复用画布视频节点（TaskNode 的 video 类型）：
 * <ol>
 *   <li>视频区复用视频节点同款视觉：标题行（剪辑 / 查看历史）+ 抽帧预览（公共组件 VideoFramePreview）+ 播放器；</li>
 *   <li>顶部保留分镜号「分镜N」+ 时长、右侧状态圆点（生成中呼吸态）；</li>
 *   <li>选中后底部工具栏保持分镜视频节点原有布局（上游参考 + 分镜提示词 + 模型/画幅/分辨率/积分/生成）；</li>
 *   <li>视频节点底部的「智能提示词」迁移到本节点工具栏。</li>
 * </ol>
 *
 * <p>与 tapCanvas 现有 storyboard 节点（分镜图生视频）区分：本节点是「参考图 + 提示词生视频」，
 * 现有 storyboard 节点保留不动。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Handle, Position, NodeToolbar, useReactFlow, type Node, type NodeProps } from '@xyflow/react'
import { ActionIcon, Button, Group, Select, Switch, Text, Textarea, Tooltip, Menu } from '@mantine/core'
import {
  IconBrain,
  IconClock,
  IconListSearch,
  IconPlayerPause,
  IconPlayerPlay,
  IconScissors,
  IconX,
} from '@tabler/icons-react'
import { useRFStore } from '../../canvas/store'
import { useMantineColorScheme } from '@mantine/core'
import { LensReferencePicker } from '../components/LensReferencePicker'
import { connectShotReferences, disconnectShotReference, referenceFromNode, referenceKey } from './lensShotReferences'
import { useUIStore } from '../../ui/uiStore'
import { collectOrderedUpstreamReferenceItems } from './taskNode/upstreamReferences'
import { VideoFramePreview } from './taskNode/components/VideoFramePreview'
import { collectUpstreamVideoTextContext } from './taskNode/videoPromptGeneration'
import {
  findModelOptionByIdentifier,
  getModelOptionRequestAlias,
  readLensModelIsDefault,
  useModelOptions,
} from '../../config/useModelOptions'
import { resolveModelGenerationCredits } from '../../config/modelPricing'
import { useCanvasRenderContext } from '../CanvasRenderContext'
import { editStoryboard, clearStoryboardSpeaker, submitShotVideo, type LensAssetEnriched } from '../../api/lens'
import { runPublicTask } from '../../api/server'
import { extractTextFromTaskResult, genTaskNodeId } from './taskNodeHelpers'
import { getAuthToken } from '../../auth/store'
import { toast } from '../../ui/toast'
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
  /** 父级资产ID（子角色/子场景才有）：用于角标区分「子角色」「子场景」 */
  parentId?: string
}

/**
 * 引用角标文案：子角色/子场景按 parentId 区分，主资产仍显示角色/场景。
 *
 * @param ref 分镜引用（只需 category 与 parentId）
 * @returns 角标中文文案
 */
export function refBadgeLabel(ref: { category: number; parentId?: string }): string {
  if (ref.category === 1) return ref.parentId ? '子角色' : '角色'
  if (ref.category === 2) return ref.parentId ? '子场景' : '场景'
  if (ref.category === 3) return '道具'
  if (ref.category === 4) return '站位'
  return '引用'
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

/** 秒数格式化：小于 60 秒显示 8s，超过 1 分钟显示 1分12s */
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
 *
 * @param assets 分镜引用资产快照
 * @param shotId 分镜ID（只保留 refId 匹配该分镜的资产）
 * @param speakerList 当前说话者基础名列表
 * @returns 分镜引用列表
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
        // 子角色/子场景角标需要 parentId 区分（refBadgeLabel 按它判断是否子资产）
        ...(asset.parentId ? { parentId: String(asset.parentId) } : null),
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
}function LensShotNode({ id, data, selected }: NodeProps<LensShotNodeType>): JSX.Element {
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
  // 智能提示词生成中（能力迁移自视频节点底部的智能提示词按钮）
  const [smartPromptLoading, setSmartPromptLoading] = useState<boolean>(false)
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

  // 模型默认值：节点未存模型时取剧配置页配置的默认生视频模型（后端 /api/model/shot_video 的 markDefault → isDefault），
  // 未配置默认模型才回退到列表第一个模型，避免「模型默认为空」导致无法直接生成。
  //
  // 注意必须用「渲染期派生」而不是 effect：模型列表首帧为空（异步加载），
  // 若依赖 effect 会出现「下拉框先显示列表第一项、随后被改回默认模型」的闪烁。
  useEffect(() => {
    const current = typeof modelValue === 'string' ? modelValue.trim() : ''
    if (current) return
    if (models.length === 0) return
    const configuredDefault = models.find((option) => readLensModelIsDefault(option.meta) && !option.disabled)
    const fallback = configuredDefault || models[0]
    if (!fallback) return
    setModelValue(fallback.value)
    // 持久化到节点数据：flow 只存模型 id（模型能力/报价仍在 lens_application，不复制到 flow）
    useRFStore.getState().updateNodeData(id, { model: fallback.value })
  }, [id, models, modelValue])

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
    setPromptDraft(String(data.prompt ?? ''))
  }, [data.scriptContent, data.timeOfDay, data.prompt])

  // 模型回填：只跟随「节点数据里真实的模型变化」（如切集/刷新后后端投影了新模型）。
  // 不能在 data.model 为空时把本地已选模型清掉 —— 那会把默认模型/用户选择打回空值，
  // 表现为「下拉框短暂显示默认模型后又变回列表第一项」。
  useEffect(() => {
    const persisted = typeof data.model === 'string' && data.model ? data.model : ''
    if (!persisted) return
    setModelValue((prev) => (prev === persisted ? prev : persisted))
  }, [data.model])

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
    return `${m}:` + String(s % 60).padStart(2, '0')
  }, [])

  // 引用行：按 场景→道具→角色→站位 排序（定义在 handleGenerate 之前，避免 TDZ）
  const refs = (Array.isArray(data.refs) ? [...data.refs] : []).sort(
    (a, b) => (REF_ORDER[a.category] ?? 9) - (REF_ORDER[b.category] ?? 9),
  )

  /** 提交生成用的提示词：优先分镜提示词草稿，为空回退分镜剧本 */
  const effectivePrompt = useCallback((): string => {
    const promptText = String(promptDraft || '').trim()
    if (promptText) return promptText
    return String(scriptDraft || '').trim()
  }, [promptDraft, scriptDraft])  /** 保存到分镜板：写回节点数据 + /api/storyboard/edit */
  const handleSave = useCallback(async () => {
    useRFStore.getState().updateNodeData(id, { scriptContent: scriptDraft, timeOfDay: timeDraft, model: modelValue })
    const storyboardId = String(data.entityId ?? '')
    const dramaId = String(data.sourceProjectId ?? '')
    if (storyboardId && dramaId) {
      try {
        await editStoryboard({ id: storyboardId, dramaId, scriptContent: scriptDraft, timeOfDay: timeDraft })
        setSaveState('已同步到分镜板')
      } catch (err) {
        const msg = err instanceof Error ? err.message : '未知错误'
        setSaveState('同步失败：' + msg)
      }
    }
  }, [id, data.entityId, data.sourceProjectId, scriptDraft, timeDraft, modelValue])

  /**
   * 智能提示词：生成当前分镜的生视频提示词。
   *
   * <p>能力迁移自视频节点底部工具栏的「智能提示词」（TaskNode.handleSmartGenerateVideoPrompt），
   * 差异只有三处：
   * 1. 上游文本上下文取画布连线上的上游文本节点（与视频节点同一采集函数）；
   * 2. 分镜没有上游文本连线时，用分镜自身剧本作为上下文；
   * 3. 结果写回节点提示词草稿与 node data.prompt，提交生成时直接使用。
   */
  const handleSmartGeneratePrompt = useCallback(async () => {
    if (smartPromptLoading) return
    const state = useRFStore.getState()
    const upstreamContext = collectUpstreamVideoTextContext(state.nodes, state.edges, id)
    const ownScript = String(scriptDraft || data.scriptContent || '').trim()
    const contextText = upstreamContext.combinedText.trim() || ownScript
    if (!contextText) {
      toast('请先填写分镜剧本或连接上游文本节点，再智能生成分镜提示词', 'warning')
      return
    }

    const systemPrompt = [
      '你是 TapCanvas 的视频提示词生成助手。',
      '你的唯一任务是根据上游文本上下文，输出当前视频节点唯一的最终执行 prompt。',
      '只输出最终 prompt 正文，不要解释、不要标题、不要 Markdown、不要 JSON。',
      '若上游文本冲突严重或信息不足以生成稳定 prompt，必须只输出一行：ERROR: 具体原因。',
    ].join('\n')

    const durationForPrompt = clampDuration(durationValue, minDuration, maxDuration)
    const durationText = durationForPrompt === null
      ? (typeof data.time === 'number' ? String(data.time) : '')
      : String(durationForPrompt)
    const refsText = refs.length
      ? '本分镜引用资产：' + refs.map((ref) => (REF_LABEL[ref.category] || '引') + '·' + ref.name).join('、')
      : null
    const currentDraft = String(promptDraft || '').trim()
    const promptText = [
      '请基于以下上下文，生成当前分镜视频的最终执行 prompt。',
      '视频参数：时长=' + durationText + 's；画幅=' + (aspectValue || '16:9'),
      refsText,
      currentDraft ? '当前节点已有 prompt 草稿（可参考但不要机械复述）：\n' + currentDraft : null,
      '上游文本上下文（按画布连接顺序拼接）：',
      contextText,
      '输出要求：',
      '- 只输出最终视频 prompt 正文。',
      '- 把明确的镜头顺序、动作、场景、节奏、台词线索和连续性约束压缩进一条连贯 prompt。',
      '- 不要返回“Shot 1/镜头 1/分点列表/说明文字”。',
      '- 如果证据冲突或不足，请输出 ERROR。',
    ]
      .filter(Boolean)
      .join('\n\n')

    try {
      setSmartPromptLoading(true)
      const ui = useUIStore.getState()
      const apiKey = (ui.publicApiKey || '').trim()
      const token = getAuthToken()
      if (!apiKey && !token) {
        toast('请先登录后再试', 'error')
        return
      }
      // 精修模型沿用节点当前选择的模型（lens 模型 value 即应用ID，接口接受该标识）
      const candidateModel = String(data.model || modelValue || '').trim()
      const matchedModel = candidateModel ? findModelOptionByIdentifier(models, candidateModel) : null
      const promptRefineModelAlias = matchedModel ? getModelOptionRequestAlias(models, matchedModel.value) : ''
      const taskRes = await runPublicTask(apiKey, {
        request: {
          kind: 'prompt_refine',
          prompt: promptText,
          extras: {
            systemPrompt,
            ...(promptRefineModelAlias ? { modelAlias: promptRefineModelAlias } : {}),
            persistAssets: false,
          },
        },
      })
      const nextPrompt = extractTextFromTaskResult(taskRes.result).trim()
      if (!nextPrompt) throw new Error('模型未返回视频提示词')
      if (nextPrompt.indexOf('ERROR') === 0 || nextPrompt.indexOf('ERROR:') === 0) {
        throw new Error(nextPrompt.replace(/^ERROR\s*:\s*/i, '').trim() || '上游文本不足，无法生成视频提示词')
      }
      setPromptDraft(nextPrompt)
      // 写回 node data.prompt（与 lens 分镜 prompt 同口径，生成时直接下发）
      useRFStore.getState().updateNodeData(id, { prompt: nextPrompt })
      toast('已根据上下文生成分镜提示词', 'success')
    } catch (error: unknown) {
      const message = error instanceof Error && error.message ? error.message : '生成视频提示词失败'
      toast(message, 'error')
    } finally {
      setSmartPromptLoading(false)
    }
  }, [
    aspectValue,
    data.model,
    data.scriptContent,
    data.time,
    durationValue,
    id,
    maxDuration,
    minDuration,
    modelValue,
    models,
    promptDraft,
    refs,
    scriptDraft,
    smartPromptLoading,
  ])

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
        prompt: effectivePrompt(),
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
      const msg = err instanceof Error ? err.message : '未知错误'
      setSaveState('提交失败：' + msg)
    }
  }, [data.entityId, data.sourceProjectId, data.episodeNum, effectivePrompt, modelValue, refs, aspectValue, resolutionValue, durationValue, minDuration, maxDuration])

  /**
   * 剪辑：复用画布视频节点的 WebCut 剪辑入口。
   *
   * <p>剪辑结果落成新的画布视频节点（与视频节点行为一致），不覆盖分镜当前视频；
   * 分镜要采用新视频仍走「任务结果 → 采纳」，避免剪辑动作隐式改写业务表。
   */
  const handleClip = useCallback(() => {
    const src = String(data.selectedImageUrl || '').trim()
    if (!src) {
      toast('当前分镜没有可剪辑的视频', 'error')
      return
    }
    const baseTitle = '分镜' + String(data.storyboardOrder ?? '-')
    const sourceNode = useRFStore.getState().nodes.find((node) => node.id === id)
    const basePosition = sourceNode?.position ?? { x: 0, y: 0 }
    useUIStore.getState().openWebCutVideoEditModal({
      nodeId: id,
      videoUrl: src,
      videoTitle: baseTitle,
      onApply: async (result) => {
        // 剪辑结果落成新的视频节点，与来源节点右侧对齐，不覆盖分镜当前视频
        const newNodeId = genTaskNodeId()
        useRFStore.setState((state) => ({
          nodes: [...state.nodes.map((node) => ({ ...node, selected: false })), {
            id: newNodeId,
            type: 'taskNode' as const,
            position: { x: Number(basePosition.x) + 520, y: Number(basePosition.y) },
            data: {
              label: baseTitle + '-剪辑',
              kind: 'video',
              videoUrl: result.url,
              videoResults: [{ url: result.url, thumbnailUrl: result.thumbnailUrl || null, title: baseTitle }],
              videoPrimaryIndex: 0,
              videoThumbnailUrl: result.thumbnailUrl || null,
              videoTitle: baseTitle,
              serverAssetId: result.assetId,
            },
            selected: true,
          }],
        }))
        const created = useRFStore.getState().nodes.some((node) => node.id === newNodeId)
        if (!created) {
          toast('剪辑已上传，但未能创建新视频节点', 'error')
          return
        }
        toast('剪辑结果已生成新视频节点', 'success')
      },
    })
  }, [data.selectedImageUrl, data.storyboardOrder, id])

  /** 抽帧预览的提示出口：抽帧逻辑在公共组件 VideoFramePreview 内，回调统一走节点 toast */
  const handleFramePreviewNotify = useCallback((message: string, level: 'success' | 'error') => {
    toast(message, level)
  }, [])

  /**
   * 查看历史：分镜节点的历史生视频任务由画布宿主的任务结果抽屉承载
   * （与视频节点「查看历史」等价：只读展示该分镜历史生成结果并可采纳）。
   */
  const handleViewHistory = useCallback(() => {
    if (!onOpenTaskResult) {
      toast('当前画布未提供任务结果入口', 'error')
      return
    }
    onOpenTaskResult(id)
  }, [id, onOpenTaskResult])

  // 横屏：宽 800、高按比例（16:9→450）；竖屏：高度限制 720、宽度随高度收窄（9:16→720×405），视频完整不裁切
  const HEADER_HEIGHT = 44
  const REFS_BAR_HEIGHT = 38
  // 视频内容区在媒体上方还有「标题行 + 抽帧操作行」，计入节点高度避免内容溢出
  const VIDEO_CONTENT_CHROME_HEIGHT = 76
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
  // 有视频结果时内容区为视频节点同款 VideoContent（含抽帧操作行），高度需把其内部占位计入
  const isVideoResult = hasResult && data.selectFileType === 1
  const contentChromeHeight = isVideoResult ? VIDEO_CONTENT_CHROME_HEIGHT : 0
  const shellHeight = mediaHeight + contentChromeHeight + HEADER_HEIGHT + (showRefs && refs.length > 0 ? REFS_BAR_HEIGHT : 0)

  const shell = {
    background: isDark ? 'rgba(15,20,28,0.96)' : 'rgba(255,255,255,0.98)',
    border: selected ? '1px solid #5b8def' : isDark ? '1px solid rgba(255,255,255,0.06)' : '1px solid rgba(15,23,42,0.08)',
    boxShadow: selected ? '0 0 0 3px rgba(91,141,239,0.25), 0 8px 24px rgba(0,0,0,0.12)' : '0 4px 16px rgba(0,0,0,0.08)',
    color: isDark ? '#f0f0f0' : '#1d2129',
    borderRadius: 12,
    // 宽度随视频比例、高度随视频比例（+顶部栏/引用行高）
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

      {/* 顶部栏：分镜号 + 时长（紧跟序号左侧）+ 状态圆点（时长取分镜 time 字段或视频实际时长） */}
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

      {/* 中间区：视频（复用视频节点 VideoContent）/ 图片 / 脚本 */}
      <div className="lens-shot-body" style={{ flex: 1, minHeight: 0, padding: 8, overflow: 'hidden' }}>
        {hasResult ? (
          isVideoResult ? (
            /* 视频区复用视频节点同款视觉：标题行（共 N 个视频 / 剪辑 / 查看历史）+ 抽帧预览 + 播放器 */
            <div
              className="video-content lens-shot-video-content"
              style={{
                width: '100%',
                height: '100%',
                minHeight: 0,
                borderRadius: 10,
                background: isDark ? 'rgba(15,20,28,0.96)' : 'rgba(255,255,255,0.98)',
                padding: 8,
                display: 'flex',
                flexDirection: 'column',
                flex: 1,
                gap: 6,
                color: isDark ? '#f0f0f0' : '#1d2129',
              }}
            >
              <Group className="video-content-header" justify="space-between" gap={4}>
                <Text className="video-content-header-text" size="xs" c="dimmed">
                  共 1 个视频（主视频：第 1 个）
                </Text>
                <Group className="video-content-header-actions" gap={2}>
                  {/* 剪辑：复用视频节点的 WebCut 剪辑入口，结果落到新的画布视频节点 */}
                  <Button
                    className="video-content-clip-button"
                    size="compact-xs"
                    variant="subtle"
                    onClick={handleClip}
                    leftSection={<IconScissors className="video-content-clip-icon" size={12} />}
                  >
                    剪辑
                  </Button>
                  {/* 查看历史：打开该分镜的历史生视频任务（与视频节点「查看历史」等价） */}
                  <Button
                    className="video-content-history-button"
                    size="compact-xs"
                    variant="subtle"
                    onClick={handleViewHistory}
                    leftSection={<IconClock className="video-content-history-icon" size={12} />}
                  >
                    查看历史
                  </Button>
                </Group>
              </Group>

              {/* 抽帧预览：与视频节点共用同一组件（抽出的帧可拖到画布生成图片节点） */}
              <VideoFramePreview
                className="video-content-actions-row"
                videoUrl={String(data.selectedImageUrl || '')}
                durationSeconds={mediaSeconds}
                onNotify={handleFramePreviewNotify}
              />

              {/* 播放器：自绘控制条（去掉原生 controls，双击放大到该节点而不是浏览器全屏） */}
              <div className="lens-shot-video-wrap" style={{ position: 'relative', flex: 1, minHeight: 0 }}>
                <video
                  ref={videoRef}
                  className="lens-shot-media video-content-player"
                  src={String(data.selectedImageUrl || '')}
                  preload="metadata"
                  playsInline
                  onClick={togglePlay}
                  onDoubleClickCapture={(evt) => {
                    // 双击视频：放大到该节点（无原生 controls，不会触发浏览器全屏）
                    zoomToSelf(evt)
                  }}
                  onPlay={() => { pauseOtherVideos(); setIsPlaying(true) }}
                  onPause={() => setIsPlaying(false)}
                  onTimeUpdate={(evt) => setCurrentSec(evt.currentTarget.currentTime)}
                  onLoadedMetadata={(evt) => {
                    const video = evt.currentTarget
                    if (video.videoWidth > 0 && video.videoHeight > 0) {
                      setMediaAspect(video.videoWidth / video.videoHeight)
                    }
                    if (Number.isFinite(video.duration) && video.duration > 0) {
                      setMediaSeconds(Math.round(video.duration))
                      setDurationSec(video.duration)
                    }
                  }}
                  style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 8, display: 'block', background: isDark ? 'rgba(0,0,0,0.45)' : 'rgba(15,23,42,0.06)' }}
                />
                {/* 自绘视频控制条：播放/暂停 + 进度 + 时间 */}
                <div
                  className="lens-shot-video-controls"
                  style={{ position: 'absolute', left: 6, right: 6, bottom: 6, display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', borderRadius: 8, background: 'rgba(10,14,20,0.66)', backdropFilter: 'blur(8px)', zIndex: 2 }}
                  onDoubleClick={(evt) => { evt.stopPropagation(); zoomToSelf(evt) }}
                >
                  <Tooltip label={isPlaying ? '暂停' : '播放'} position="top" withArrow>
                    <span
                      className="lens-shot-video-toggle"
                      onClick={(evt) => { evt.stopPropagation(); togglePlay() }}
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
                    onClick={(evt) => evt.stopPropagation()}
                    onChange={(evt) => {
                      const video = videoRef.current
                      const next = Number(evt.currentTarget.value)
                      if (video) { video.currentTime = next }
                      setCurrentSec(next)
                    }}
                    style={{ flex: 1, minWidth: 0, accentColor: '#60a5fa' }}
                  />
                  <Text size="xs" style={{ color: 'rgba(255,255,255,0.85)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                    {formatClock(currentSec)} / {formatClock(durationSec || mediaSeconds || 0)}
                  </Text>
                </div>
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
            <Tooltip key={String(ref.category) + '-' + String(ref.id)} label={ref.name} position="top" withArrow>
              <span className="lens-shot-ref" style={{ position: 'relative', display: 'inline-flex', cursor: ref.category === 1 ? 'pointer' : 'default' }}>
                {ref.imgUrl ? (
                  <img className="lens-shot-ref-img" src={ossThumb(ref.imgUrl)} alt={ref.name} style={{ width: 30, height: 30, objectFit: 'cover', borderRadius: 4, border: '1px solid rgba(127,127,127,0.2)' }} />
                ) : (
                  <span className="lens-shot-ref-empty" style={{ width: 30, height: 30, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, border: '1px solid rgba(127,127,127,0.2)', fontSize: 10, opacity: 0.7 }}>{ref.name.slice(0, 1)}</span>
                )}
                {ref.category === 1 && (
                  <span
                    className={['lens-shot-speaker', ref.isSpeaker ? 'is-speaker' : ''].filter(Boolean).join(' ')}
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

      {/* 选中时节点下方浮出编辑面板（底部工具栏保持分镜视频节点原有布局） */}
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
                  <Tooltip key={String(ref.category) + '-' + String(ref.id)} label={ref.name} position="top" withArrow>
                    <span className="lens-shot-toolbar-reference" style={{ position: 'relative', display: 'inline-flex', cursor: 'grab' }}>
                      {ref.imgUrl ? (
                        <img src={ossThumb(ref.imgUrl)} alt={ref.name} style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 10, border: '1px solid rgba(127,127,127,0.18)' }} />
                      ) : (
                        <span style={{ width: 44, height: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 10, border: '1px solid rgba(127,127,127,0.18)', fontSize: 10, opacity: 0.7 }}>{ref.name.slice(0, 1)}</span>
                      )}
                      <span style={{ position: 'absolute', left: 3, bottom: 3, fontSize: 9, lineHeight: 1, padding: '2px 5px', borderRadius: 999, background: 'rgba(10,14,20,0.72)', color: 'rgba(255,255,255,0.85)', backdropFilter: 'blur(4px)' }}>{REF_LABEL[ref.category] ?? '引'}</span>
                      <ActionIcon
                        className="lens-shot-toolbar-reference-remove nodrag nopan"
                        size={18} variant="filled" color="dark"
                        aria-label={'删除 ' + ref.name + ' 引用及连线'}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation()
                          void disconnectShotReference(id, ref).catch((error: unknown) => {
                            const msg = error instanceof Error ? error.message : String(error)
                            setSaveState('删除参考失败：' + msg)
                          })
                        }}
                      >
                        <IconX size={12} stroke={2.5} />
                      </ActionIcon>
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
              {/* 编辑区：时长 + 分镜提示词/剧本 切换 + 智能提示词 + 保存；提示词为分镜生视频提示词 data.prompt */}
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
                          const msg = err instanceof Error ? err.message : '未知错误'
                          setSaveState('时长同步失败：' + msg)
                        })
                      }
                    }}
                    placeholder="时长"
                    aria-label="生成时长"
                  />
                </Group>
                <Group className="lens-shot-prompt-header-actions" gap={8} align="center" justify="flex-end" wrap="nowrap">
                  {/* 智能提示词：迁移自视频节点底部的智能提示词，按画布上下文生成分镜生视频提示词 */}
                  <Tooltip label="智能提示词（依据上游文本/分镜剧本生成）" position="top" withArrow>
                    <ActionIcon
                      className="lens-shot-smart-prompt nodrag nopan"
                      variant="light"
                      color="blue"
                      size="md"
                      aria-label="智能提示词"
                      loading={smartPromptLoading}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => { event.stopPropagation(); void handleSmartGeneratePrompt() }}
                    >
                      <IconBrain size={16} />
                    </ActionIcon>
                  </Tooltip>
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
                  <Text size="xs" fw={600} style={{ whiteSpace: 'nowrap', padding: '3px 9px', borderRadius: 999, background: 'rgba(127,127,127,0.12)' }}>{consumePoints === null ? '积分未配置' : String(consumePoints) + ' 积分'}</Text>
                  <Button size="xs" variant="filled" onClick={() => void handleGenerate()}>生成</Button>
                </Group>
              </div>
              {saveState && <Text size="xs" c="dimmed" mt={8} style={{ textAlign: 'right' }}>{saveState}</Text>}
            </div>
          </div>
        </NodeToolbar>
      )}

      <LensReferencePicker
        opened={assetPickerOpened}
        dramaId={String(data.sourceProjectId || '')}
        existingKeys={(data.refs || []).map(referenceKey)}
        onClose={() => setAssetPickerOpened(false)}
        onConfirm={(assets) => connectShotReferences(id, assets)}
      />
    </div>
  )
}

export default memo(LensShotNode)