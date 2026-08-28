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
import { memo, useCallback, useEffect, useState } from 'react'
import { Handle, Position, NodeToolbar, type Node, type NodeProps } from '@xyflow/react'
import { Button, Group, Paper, Select, Switch, Text, Textarea, Tooltip } from '@mantine/core'
import { useRFStore } from '../../canvas/store'
import { useMantineColorScheme } from '@mantine/core'
import { useModelOptions } from '../../config/useModelOptions'
import { editStoryboard, clearStoryboardSpeaker, submitShotVideo } from '../../api/lens'

/** 分镜引用（底部引用行）：场景/道具/角色/站位 */
export interface LensShotRef {
  /** 1=角色 2=场景 3=道具 4=站位 */
  category: number
  id: string
  name: string
  imgUrl?: string
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
      ? data.refs.map((r) => (r.category === 1 && r.name === roleName ? { ...r, isSpeaker: next.includes(roleName) } : r))
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
  const { colorScheme } = useMantineColorScheme()
  const isDark = colorScheme === 'dark'
  const showRefs = Boolean(data.showRefs)
  const hasResult = Boolean(data.selectedImageUrl && String(data.selectedImageUrl).trim())
  // 媒体（图/视频）实际宽高比：节点高度恒 216，宽度按比例自适应（竖屏变窄、横屏变宽）
  const [mediaAspect, setMediaAspect] = useState<number | null>(null)
  // 分镜时长（秒）：优先 lens 分镜 time 字段，有视频时用视频实际时长
  const [mediaSeconds, setMediaSeconds] = useState<number | null>(typeof data.time === 'number' && data.time > 0 ? data.time : null)
  // lens 模式下 useModelOptions('video') 走 /api/model/shot_video（分镜生视频模型）
  const models = useModelOptions('video')
  // 编辑区草稿（选中展开时显示，保存时写回节点 + 同步分镜板）
  const [scriptDraft, setScriptDraft] = useState<string>(String(data.scriptContent ?? ''))
  const [timeDraft, setTimeDraft] = useState<string>(String(data.timeOfDay ?? ''))
  const [modelValue, setModelValue] = useState<string | null>(typeof data.model === 'string' && data.model ? data.model : null)
  const [saveState, setSaveState] = useState<string>('')
  // 提示词编辑模式：text=分镜脚本，json=生视频提示词
  const [promptMode, setPromptMode] = useState<'text' | 'json'>('text')
  const [promptDraft, setPromptDraft] = useState<string>(String(data.prompt ?? ''))
  // 画幅 / 分辨率（生成参数，随节点持久化）
  const [aspectValue, setAspectValue] = useState<string>(String(data.aspectRatio ?? '16:9'))
  const [resolutionValue, setResolutionValue] = useState<string>(String(data.resolution ?? '1080p'))
  // 所选模型的单次积分消耗（lens 模型接口 unitConsume）
  const selectedModel = models.find((m) => m.value === modelValue)
  const consumePoints = (selectedModel?.meta as { lensUnitConsume?: number } | undefined)?.lensUnitConsume ?? '—'

  // 换媒体时重置比例与时长，等新图/视频加载后重新计算
  useEffect(() => {
    setMediaAspect(null)
    setMediaSeconds(typeof data.time === 'number' && data.time > 0 ? data.time : null)
  }, [data.selectedImageUrl, data.time])

  // 节点数据变化时回填编辑草稿（如切集/刷新后）
  useEffect(() => {
    setScriptDraft(String(data.scriptContent ?? ''))
    setTimeDraft(String(data.timeOfDay ?? ''))
    setModelValue(typeof data.model === 'string' && data.model ? data.model : null)
    setPromptDraft(String(data.prompt ?? ''))
    setAspectValue(String(data.aspectRatio ?? '16:9'))
    setResolutionValue(String(data.resolution ?? '1080p'))
  }, [data.scriptContent, data.timeOfDay, data.model, data.prompt, data.aspectRatio, data.resolution])

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
    setSaveState('任务提交中…')
    try {
      await submitShotVideo({
        dramaId,
        episodeNum: Number(data.episodeNum ?? 1),
        storyboardId,
        model: modelValue,
        appid: Number(modelValue) || undefined,
        prompt: scriptDraft || String(data.prompt ?? ''),
        aspectRatio: aspectValue,
        resolution: resolutionValue,
        refImages: JSON.stringify(refs.map((r) => r.imgUrl).filter(Boolean)),
      })
      setSaveState('已提交生视频任务')
    } catch (err) {
      setSaveState(`提交失败：${err instanceof Error ? err.message : '未知错误'}`)
    }
  }, [data.entityId, data.sourceProjectId, data.episodeNum, data.prompt, scriptDraft, modelValue, refs, aspectValue, resolutionValue])

  // 媒体区域尺寸：短边基准 384——横屏宽 384、竖屏高 384，另一条边按实际宽高比自适应（clamp 96~640）
  // 节点高度随媒体动态（竖屏视频完整大小播放，编辑面板为独立浮层不撑高节点）
  const MEDIA_SHORT_EDGE = 384
  const HEADER_HEIGHT = 30
  let mediaWidth = 384
  let mediaHeight = 216
  if (mediaAspect) {
    if (mediaAspect >= 1) {
      mediaWidth = MEDIA_SHORT_EDGE
      mediaHeight = Math.min(640, Math.max(96, MEDIA_SHORT_EDGE / mediaAspect))
    } else {
      mediaHeight = MEDIA_SHORT_EDGE
      mediaWidth = Math.min(640, Math.max(96, MEDIA_SHORT_EDGE * mediaAspect))
    }
  }
  const shellWidth = Math.round(mediaWidth)
  const shellHeight = Math.round(mediaHeight) + HEADER_HEIGHT

  const shell = {
    background: isDark ? 'rgba(15,20,28,0.96)' : 'rgba(255,255,255,0.98)',
    border: selected ? '1px solid #5b8def' : isDark ? '1px solid rgba(255,255,255,0.06)' : '1px solid rgba(15,23,42,0.08)',
    boxShadow: selected ? '0 0 0 3px rgba(91,141,239,0.25), 0 8px 24px rgba(0,0,0,0.12)' : '0 4px 16px rgba(0,0,0,0.08)',
    color: isDark ? '#f0f0f0' : '#1d2129',
    borderRadius: 12,
    // 宽高随媒体比例动态：横屏 384×216、竖屏 216×384（+顶部栏高）；relative 供底部悬浮引用行定位
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

      {/* 顶部栏：分镜号 + 时间段/时长 + 状态圆点（时长取分镜 time 字段或视频实际时长，不显示氛围） */}
      <div className="lens-shot-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', borderBottom: '1px solid rgba(127,127,127,0.18)', fontSize: 12, fontWeight: 600 }}>
        <span className="lens-shot-order">分镜{data.storyboardOrder ?? '-'}</span>
        {(data.timeOfDay || mediaSeconds != null) ? (
          <span className="lens-shot-time" style={{ fontWeight: 400, opacity: 0.72 }}>
            {data.timeOfDay ? data.timeOfDay : ''}
            {data.timeOfDay && mediaSeconds != null ? ' · ' : ''}
            {mediaSeconds != null ? formatSeconds(mediaSeconds) : ''}
          </span>
        ) : null}
        <StatusDot data={data} />
      </div>

      {/* 中间区：图/视频 或 脚本（占满剩余空间，媒体按实际宽高比自适应节点宽度） */}
      <div className="lens-shot-body" style={{ flex: 1, minHeight: 0, padding: 8, overflow: 'hidden' }}>
        {hasResult ? (
          data.selectFileType === 1 ? (
            <video
              className="lens-shot-media"
              src={data.selectedImageUrl}
              controls
              preload="metadata"
              onLoadedMetadata={(e) => {
                const v = e.currentTarget
                if (v.videoWidth > 0 && v.videoHeight > 0) {
                  setMediaAspect(v.videoWidth / v.videoHeight)
                }
                if (Number.isFinite(v.duration) && v.duration > 0) {
                  setMediaSeconds(Math.round(v.duration))
                }
              }}
              style={{ width: '100%', height: '100%', objectFit: 'contain', borderRadius: 6, display: 'block', background: 'rgba(0,0,0,0.35)' }}
            />
          ) : (
            <img
              className="lens-shot-media"
              src={data.selectedImageUrl}
              alt="分镜图"
              onLoad={(e) => {
                const img = e.currentTarget
                if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                  setMediaAspect(img.naturalWidth / img.naturalHeight)
                }
              }}
              style={{ width: '100%', height: '100%', objectFit: 'contain', borderRadius: 6, display: 'block' }}
            />
          )
        ) : (
          <div className="lens-shot-script" style={{ fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', height: '100%', overflow: 'auto' }}>
            {data.scriptContent || '（暂无脚本）'}
          </div>
        )}

      </div>
      {/* 选中时节点下方浮出独立编辑面板（完整复刻角色/场景节点的编辑弹框布局） */}
      {selected && (
        <NodeToolbar className="lens-shot-edit-toolbar" position={Position.Bottom} align="start">
          <Paper className="lens-shot-edit-panel" shadow="lg" radius="md" p={12} withBorder style={{ width: 480 }}>
    <Text size="sm" fw={600} style={{ marginBottom: 10 }}>分镜编辑</Text>

              {/* 上游参考：缩略图 + 添加按钮 + 拖动调整顺序（对齐角色节点） */}
              <Text size="xs" c="dimmed" style={{ marginBottom: 4 }}>上游参考</Text>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
                {refs.length > 0 ? refs.map((ref) => (
                  <Tooltip key={`${ref.category}-${ref.id}`} label={`${REF_LABEL[ref.category] ?? '引用'} · ${ref.name}`} position="top" withArrow>
                    <span style={{ position: 'relative', display: 'inline-flex', cursor: 'grab' }}>
                      {ref.imgUrl ? (
                        <img src={ossThumb(ref.imgUrl)} alt={ref.name} style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 6, border: '1px solid rgba(127,127,127,0.25)' }} />
                      ) : (
                        <span style={{ width: 44, height: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, border: '1px solid rgba(127,127,127,0.25)', fontSize: 10, opacity: 0.7 }}>{ref.name.slice(0, 1)}</span>
                      )}
                      <span style={{ position: 'absolute', left: -2, bottom: -2, fontSize: 9, padding: '0 3px', borderRadius: 4, background: 'rgba(20,30,45,0.85)', color: '#fff' }}>{REF_LABEL[ref.category] ?? '引'}</span>
                    </span>
                  </Tooltip>
                )) : (
                  <Text size="xs" c="dimmed">暂无引用资产</Text>
                )}
                <Tooltip label="添加参考（后续支持从画布选取）" position="top" withArrow>
                  <span
                    style={{ width: 44, height: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, border: '1px dashed rgba(127,127,127,0.45)', fontSize: 16, color: 'rgba(127,127,127,0.8)', cursor: 'pointer' }}
                    title="添加参考"
                  >
                    +
                  </span>
                </Tooltip>
              </div>
              <Text size="xs" c="dimmed" style={{ marginBottom: 10 }}>拖动调整顺序</Text>

              {/* 提示词编辑区（对齐角色节点「提示词编辑模式」区）：文本=脚本，JSON=生视频提示词 */}
              <Group justify="space-between" align="center" mb={4}>
                <Text size="xs" fw={600}>提示词编辑模式</Text>
                <Switch
                  size="xs"
                  label="JSON"
                  checked={promptMode === 'json'}
                  onChange={(e) => setPromptMode(e.currentTarget.checked ? 'json' : 'text')}
                />
              </Group>
              <Textarea
                size="xs"
                autosize
                minRows={4}
                maxRows={6}
                value={promptMode === 'json' ? promptDraft : scriptDraft}
                onChange={(e) => {
                  const next = e.currentTarget.value
                  if (promptMode === 'json') setPromptDraft(next)
                  else setScriptDraft(next)
                }}
                placeholder={promptMode === 'json' ? '生视频提示词（JSON）' : '分镜脚本（含动作与对白）'}
                mb={10}
              />

              {/* 底部控制栏：模型 + 画幅 + 分辨率 + 积分 + 生成（对齐角色节点） */}
              <Group gap={6} align="flex-end" wrap="nowrap">
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
                <Select
                  size="xs"
                  w={88}
                  data={[{ value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' }]}
                  value={aspectValue}
                  onChange={(v) => setAspectValue(v ?? '16:9')}
                />
                <Select
                  size="xs"
                  w={88}
                  data={[{ value: '720p', label: '720p' }, { value: '1080p', label: '1080p' }, { value: '2K', label: '2K' }]}
                  value={resolutionValue}
                  onChange={(v) => setResolutionValue(v ?? '1080p')}
                />
                <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>{consumePoints}积分</Text>
              </Group>
              <Group justify="flex-end" gap={6} mt={10}>
                {saveState && <Text size="xs" c="dimmed" style={{ marginRight: 'auto' }}>{saveState}</Text>}
                <Button size="xs" onClick={() => void handleGenerate()}>生成</Button>
                <Button size="xs" variant="light" onClick={() => void handleSave()}>保存到分镜板</Button>
              </Group>

          </Paper>
        </NodeToolbar>
      )}

    </div>
  )
}

export default memo(LensShotNode)
