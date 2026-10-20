import React from 'react'
import { Button, Group, Modal, Stack, Text, Textarea, Badge, Tooltip, SegmentedControl, Select, NumberInput } from '@mantine/core'
import { IconAdjustments } from '@tabler/icons-react'

import { runPublicTask, uploadServerAssetFile } from '../../../api/server'
import { understandImage } from '../../../api/lens'
import { isLensMode } from '../../../config/useModelOptions'
import { toast } from '../../../ui/toast'
import { useUIStore } from '../../../ui/uiStore'
import { extractTextFromTaskResult } from '../taskNodeHelpers'
import { isRemoteUrl } from './utils'
import { getAuthToken } from '../../../auth/store'
import {
  CANVAS_RESIZE_SIZE_OPTIONS,
  normalizeCanvasResizeSize,
  parseCanvasResizeSizeDimensions,
} from './imageEditSize'

export type PosePoint = { name: string; x: number; y: number }

export const POSE_CANVAS_SIZE = { width: 260, height: 260 }
const EDIT_PANEL_HEIGHT = POSE_CANVAS_SIZE.height + 220

export const createDefaultPosePoints = (): PosePoint[] => {
  const w = POSE_CANVAS_SIZE.width
  const h = POSE_CANVAS_SIZE.height
  const cx = w / 2
  const cy = h / 2
  return [
    { name: 'head', x: cx, y: cy - 110 },
    { name: 'neck', x: cx, y: cy - 80 },
    { name: 'shoulderL', x: cx - 40, y: cy - 70 },
    { name: 'elbowL', x: cx - 70, y: cy - 20 },
    { name: 'wristL', x: cx - 60, y: cy + 40 },
    { name: 'shoulderR', x: cx + 40, y: cy - 70 },
    { name: 'elbowR', x: cx + 70, y: cy - 20 },
    { name: 'wristR', x: cx + 60, y: cy + 40 },
    { name: 'hipL', x: cx - 25, y: cy - 10 },
    { name: 'kneeL', x: cx - 30, y: cy + 70 },
    { name: 'ankleL', x: cx - 25, y: cy + 130 },
    { name: 'hipR', x: cx + 25, y: cy - 10 },
    { name: 'kneeR', x: cx + 30, y: cy + 70 },
    { name: 'ankleR', x: cx + 25, y: cy + 130 },
  ]
}

const POSE_LINES: [string, string][] = [
  ['head', 'neck'],
  ['neck', 'shoulderL'],
  ['shoulderL', 'elbowL'],
  ['elbowL', 'wristL'],
  ['neck', 'shoulderR'],
  ['shoulderR', 'elbowR'],
  ['elbowR', 'wristR'],
  ['neck', 'hipL'],
  ['neck', 'hipR'],
  ['hipL', 'kneeL'],
  ['kneeL', 'ankleL'],
  ['hipR', 'kneeR'],
  ['kneeR', 'ankleR'],
  ['hipL', 'hipR'],
]

type UsePoseEditorOptions = {
  nodeId: string
  baseImageUrl: string
  poseReferenceImages?: string[]
  poseStickmanUrl?: string
  onPoseSaved?: (payload: {
    /** 编辑模式：pose=姿势调整，depth=局部修改（历史标识，界面已改名「局部修改」），size=尺寸调整 */
    mode: 'pose' | 'depth' | 'size'
    poseStickmanUrl: string | null
    poseReferenceImages: string[]
    baseImageUrl: string
    maskUrl?: string | null
    prompt?: string
    imageEditSize?: string
    resizedImageUrl?: string | null
  }) => void
  promptValue?: string
  onPromptSave?: (next: string) => void
  imageEditSize: string
  imageEditSizeOptions: Array<{ value: string; label: string; disabled?: boolean }>
  onImageEditSizeChange?: (next: string) => void
  canvasResizeSize?: string
  onCanvasResizeSizeChange?: (next: string) => void
  hasImages: boolean
  isDarkUi: boolean
  inlineDividerColor: string
  updateNodeData: (id: string, patch: any) => void
}

type PointerPhase = 'down' | 'move' | 'up'

export function usePoseEditor(options: UsePoseEditorOptions) {
  const [open, setOpen] = React.useState(false)
  const [activeBaseImageUrl, setActiveBaseImageUrl] = React.useState(() => options.baseImageUrl || '')
  const [points, setPoints] = React.useState<PosePoint[]>(() => createDefaultPosePoints())
  const [draggingIndex, setDraggingIndex] = React.useState<number | null>(null)
  const [uploading, setUploading] = React.useState(false)
  const [maskDrawing, setMaskDrawing] = React.useState(false)
  const [maskDirty, setMaskDirty] = React.useState(false)
  const [promptInput, setPromptInput] = React.useState(() => options.promptValue || '')
  /** 编辑模式：pose=姿势调整，depth=局部修改（沿用历史标识，节点数据里已存在，不改名），size=尺寸调整 */
  const [editMode, setEditMode] = React.useState<'pose' | 'depth' | 'size'>('pose')
  const [descriptionText, setDescriptionText] = React.useState('')
  const [descriptionLoading, setDescriptionLoading] = React.useState(false)
  const [descriptionError, setDescriptionError] = React.useState<string | null>(null)
  const [selectedImageEditSize, setSelectedImageEditSize] = React.useState(() => options.imageEditSize)
  const [selectedCanvasResizePreset, setSelectedCanvasResizePreset] = React.useState<string>(() => {
    const normalized = normalizeCanvasResizeSize(options.canvasResizeSize)
    return CANVAS_RESIZE_SIZE_OPTIONS.some((item) => item.value === normalized) ? normalized : '__custom__'
  })
  const initialCanvasResizeDimensions = React.useMemo(
    () => parseCanvasResizeSizeDimensions(options.canvasResizeSize) || parseCanvasResizeSizeDimensions(options.imageEditSize) || { width: 1280, height: 720 },
    [options.canvasResizeSize, options.imageEditSize],
  )
  const [customResizeWidth, setCustomResizeWidth] = React.useState<number>(initialCanvasResizeDimensions.width)
  const [customResizeHeight, setCustomResizeHeight] = React.useState<number>(initialCanvasResizeDimensions.height)
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const maskCanvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const maskCtxRef = React.useRef<CanvasRenderingContext2D | null>(null)
  const lastMaskPointRef = React.useRef<{ x: number; y: number } | null>(null)
  const maskDrawingRef = React.useRef(false)

  const poseReady = React.useMemo(() => isRemoteUrl(activeBaseImageUrl), [activeBaseImageUrl])
  const maskEnabled = editMode === 'depth'

  const openEditor = React.useCallback((baseImageUrl?: string) => {
    if (!options.hasImages) {
      toast('请先上传或生成图片', 'warning')
      return
    }
    setActiveBaseImageUrl((baseImageUrl || options.baseImageUrl || '').trim())
    setPoints(createDefaultPosePoints())
    setPromptInput(options.promptValue || '')
    setSelectedImageEditSize(options.imageEditSize)
    const normalizedCanvasResize = normalizeCanvasResizeSize(options.canvasResizeSize)
    const parsedCanvasResize = parseCanvasResizeSizeDimensions(normalizedCanvasResize) || { width: 1280, height: 720 }
    setSelectedCanvasResizePreset(
      CANVAS_RESIZE_SIZE_OPTIONS.some((item) => item.value === normalizedCanvasResize)
        ? normalizedCanvasResize
        : '__custom__',
    )
    setCustomResizeWidth(parsedCanvasResize.width)
    setCustomResizeHeight(parsedCanvasResize.height)
    setMaskDrawing(false)
    setMaskDirty(false)
    setDescriptionText('')
    setDescriptionError(null)
    setOpen(true)
  }, [options.baseImageUrl, options.hasImages, options.promptValue])

  React.useEffect(() => {
    if (!open) return
    setPromptInput(options.promptValue || '')
    setDescriptionText((prev) => prev || options.promptValue || '')
    setDescriptionError(null)
    setSelectedImageEditSize(options.imageEditSize)
    const normalizedCanvasResize = normalizeCanvasResizeSize(options.canvasResizeSize)
    const parsedCanvasResize = parseCanvasResizeSizeDimensions(normalizedCanvasResize) || { width: 1280, height: 720 }
    setSelectedCanvasResizePreset(
      CANVAS_RESIZE_SIZE_OPTIONS.some((item) => item.value === normalizedCanvasResize)
        ? normalizedCanvasResize
        : '__custom__',
    )
    setCustomResizeWidth(parsedCanvasResize.width)
    setCustomResizeHeight(parsedCanvasResize.height)
    setMaskDrawing(false)
    setMaskDirty(false)
  }, [open, options.canvasResizeSize, options.imageEditSize, options.promptValue])

  React.useEffect(() => {
    if (!open) return
    if (editMode !== 'depth') return
    setDescriptionText((prev) => prev || options.promptValue || '')
  }, [editMode, open, options.promptValue])

  const lines = React.useMemo(() => POSE_LINES, [])

  const drawPoseCanvas = React.useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, POSE_CANVAS_SIZE.width, POSE_CANVAS_SIZE.height)
    ctx.fillStyle = options.isDarkUi ? 'rgba(5,8,16,0.92)' : 'rgba(245,248,255,0.95)'
    ctx.fillRect(0, 0, POSE_CANVAS_SIZE.width, POSE_CANVAS_SIZE.height)

    ctx.strokeStyle = options.isDarkUi ? '#7dd3fc' : '#0ea5e9'
    ctx.lineWidth = 4
    ctx.lineCap = 'round'
    lines.forEach(([a, b]) => {
      const pa = points.find((p) => p.name === a)
      const pb = points.find((p) => p.name === b)
      if (!pa || !pb) return
      ctx.beginPath()
      ctx.moveTo(pa.x, pa.y)
      ctx.lineTo(pb.x, pb.y)
      ctx.stroke()
    })

    points.forEach((p) => {
      ctx.beginPath()
      ctx.fillStyle = options.isDarkUi ? '#e0f2fe' : '#0f172a'
      ctx.strokeStyle = options.isDarkUi ? '#38bdf8' : '#0ea5e9'
      ctx.lineWidth = 2
      ctx.arc(p.x, p.y, 8, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    })
  }, [lines, options.isDarkUi, points])

  React.useEffect(() => {
    if (!open) return
    // Modal content mounts after transition; wait for the canvas ref before drawing.
    let frame = requestAnimationFrame(function paint() {
      if (!canvasRef.current) {
        frame = requestAnimationFrame(paint)
        return
      }
      drawPoseCanvas()
    })
    return () => cancelAnimationFrame(frame)
  }, [open, drawPoseCanvas])

  React.useEffect(() => {
    if (!open) return
    if (editMode !== 'pose') return
    let frame = requestAnimationFrame(function paint() {
      if (!canvasRef.current) {
        frame = requestAnimationFrame(paint)
        return
      }
      drawPoseCanvas()
    })
    return () => cancelAnimationFrame(frame)
  }, [drawPoseCanvas, editMode, open])

  const initMaskCanvas = React.useCallback(() => {
    const canvas = maskCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, POSE_CANVAS_SIZE.width, POSE_CANVAS_SIZE.height)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = '#ff7a1a'
    ctx.lineWidth = 18
    ctx.globalAlpha = 0.92
    ctx.globalCompositeOperation = 'source-over'
    ctx.shadowBlur = 0
    maskCtxRef.current = ctx
    lastMaskPointRef.current = null
  }, [])

  const resetMaskState = React.useCallback((clearCanvas: boolean) => {
    if (clearCanvas && maskCtxRef.current) {
      maskCtxRef.current.clearRect(0, 0, POSE_CANVAS_SIZE.width, POSE_CANVAS_SIZE.height)
    }
    maskDrawingRef.current = false
    lastMaskPointRef.current = null
    setMaskDrawing(false)
    setMaskDirty(false)
  }, [])

  React.useEffect(() => {
    if (!open) return
    if (!maskEnabled) return
    let frame: number | null = null
    const ensureCanvas = () => {
      if (maskCanvasRef.current) {
        initMaskCanvas()
        return
      }
      frame = requestAnimationFrame(ensureCanvas)
    }
    ensureCanvas()
    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [initMaskCanvas, maskEnabled, open])

  React.useEffect(() => {
    if (!open) return
    if (maskEnabled) return
    maskCtxRef.current = null
    resetMaskState(false)
  }, [maskEnabled, open, resetMaskState])

  const handleMaskPointer = React.useCallback(
    (evt: React.MouseEvent<HTMLCanvasElement>, phase: PointerPhase) => {
      if (!maskEnabled) return
      const canvas = maskCanvasRef.current
      const ctx = maskCtxRef.current
      if (!canvas || !ctx) return
      const rect = canvas.getBoundingClientRect()
      const x = evt.clientX - rect.left
      const y = evt.clientY - rect.top

      if (phase === 'down') {
        setMaskDrawing(true)
        maskDrawingRef.current = true
        setMaskDirty(true)
        lastMaskPointRef.current = { x, y }
        ctx.beginPath()
        ctx.moveTo(x, y)
        ctx.stroke()
        return
      }

      if (phase === 'move') {
        if (!maskDrawingRef.current || !lastMaskPointRef.current) return
        ctx.lineTo(x, y)
        ctx.stroke()
        lastMaskPointRef.current = { x, y }
        return
      }

      setMaskDrawing(false)
      maskDrawingRef.current = false
      lastMaskPointRef.current = null
    },
    [maskEnabled],
  )

  const clearMask = React.useCallback(() => {
    if (maskCtxRef.current) {
      maskCtxRef.current.clearRect(0, 0, POSE_CANVAS_SIZE.width, POSE_CANVAS_SIZE.height)
      initMaskCanvas()
    }
    resetMaskState(false)
  }, [initMaskCanvas, resetMaskState])

  const handlePointer = React.useCallback(
    (evt: React.MouseEvent<HTMLCanvasElement>, phase: PointerPhase) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const x = evt.clientX - rect.left
      const y = evt.clientY - rect.top

      if (phase === 'down') {
        const hitIndex = points.findIndex((p) => Math.hypot(p.x - x, p.y - y) <= 12)
        if (hitIndex >= 0) {
          setDraggingIndex(hitIndex)
        }
        return
      }

      if (phase === 'move') {
        if (draggingIndex === null) return
        setPoints((prev) =>
          prev.map((p, idx) =>
            idx === draggingIndex
              ? {
                  ...p,
                  x: Math.max(0, Math.min(POSE_CANVAS_SIZE.width, x)),
                  y: Math.max(0, Math.min(POSE_CANVAS_SIZE.height, y)),
                }
              : p,
          ),
        )
        return
      }

      setDraggingIndex(null)
    },
    [draggingIndex, points],
  )

  const selectedSizeDimensions = React.useMemo(() => {
    const resizeValue = selectedCanvasResizePreset === '__custom__'
      ? `${Math.max(64, Math.trunc(customResizeWidth || 0))}x${Math.max(64, Math.trunc(customResizeHeight || 0))}`
      : selectedCanvasResizePreset
    const parsed = parseCanvasResizeSizeDimensions(resizeValue)
    if (!parsed) {
      return { width: 1280, height: 720, label: '1280x720' }
    }
    return {
      width: parsed.width,
      height: parsed.height,
      label: `${parsed.width}x${parsed.height}`,
    }
  }, [customResizeHeight, customResizeWidth, selectedCanvasResizePreset])

  const loadImageElement = React.useCallback(async (url: string): Promise<HTMLImageElement> => {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('加载图片失败，无法进行尺寸调整'))
      img.src = url
    })
  }, [])

  const uploadCanvasAsset = React.useCallback(async (
    canvas: HTMLCanvasElement,
    filename: string,
    failureMessage: string,
  ): Promise<string> => {
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((nextBlob) => {
        if (nextBlob) resolve(nextBlob)
        else reject(new Error(failureMessage))
      }, 'image/png')
    })
    const file = new File([blob], filename, { type: 'image/png' })
    const hosted = await uploadServerAssetFile(file, filename)
    const remoteUrl = typeof hosted?.data?.url === 'string' ? hosted.data.url.trim() : ''
    if (!remoteUrl || !isRemoteUrl(remoteUrl)) {
      throw new Error('图片上传失败，请稍后重试')
    }
    return remoteUrl
  }, [])

  const getContainedImageRect = React.useCallback((sourceWidth: number, sourceHeight: number) => {
    const scale = Math.min(
      POSE_CANVAS_SIZE.width / Math.max(1, sourceWidth),
      POSE_CANVAS_SIZE.height / Math.max(1, sourceHeight),
    )
    const width = Math.max(1, Math.round(sourceWidth * scale))
    const height = Math.max(1, Math.round(sourceHeight * scale))
    return {
      x: Math.round((POSE_CANVAS_SIZE.width - width) / 2),
      y: Math.round((POSE_CANVAS_SIZE.height - height) / 2),
      width,
      height,
    }
  }, [])

  const createMaskFocusGuideUrl = React.useCallback(async (): Promise<string | null> => {
    const maskCanvas = maskCanvasRef.current
    if (!maskEnabled || !maskDirty || !maskCanvas) return null
    const image = await loadImageElement(activeBaseImageUrl)
    const guideCanvas = document.createElement('canvas')
    guideCanvas.width = Math.max(1, image.naturalWidth)
    guideCanvas.height = Math.max(1, image.naturalHeight)
    const guideCtx = guideCanvas.getContext('2d')
    if (!guideCtx) throw new Error('Canvas 初始化失败')

    const scaledMaskCanvas = document.createElement('canvas')
    scaledMaskCanvas.width = guideCanvas.width
    scaledMaskCanvas.height = guideCanvas.height
    const scaledMaskCtx = scaledMaskCanvas.getContext('2d')
    if (!scaledMaskCtx) throw new Error('Canvas 初始化失败')

    const previewRect = getContainedImageRect(image.naturalWidth, image.naturalHeight)
    scaledMaskCtx.imageSmoothingEnabled = true
    scaledMaskCtx.imageSmoothingQuality = 'high'
    scaledMaskCtx.drawImage(
      maskCanvas,
      previewRect.x,
      previewRect.y,
      previewRect.width,
      previewRect.height,
      0,
      0,
      guideCanvas.width,
      guideCanvas.height,
    )

    const dimCanvas = document.createElement('canvas')
    dimCanvas.width = guideCanvas.width
    dimCanvas.height = guideCanvas.height
    const dimCtx = dimCanvas.getContext('2d')
    if (!dimCtx) throw new Error('Canvas 初始化失败')
    dimCtx.fillStyle = 'rgba(4,10,20,0.42)'
    dimCtx.fillRect(0, 0, dimCanvas.width, dimCanvas.height)
    dimCtx.globalCompositeOperation = 'destination-out'
    dimCtx.drawImage(scaledMaskCanvas, 0, 0)

    guideCtx.drawImage(image, 0, 0, guideCanvas.width, guideCanvas.height)
    guideCtx.drawImage(dimCanvas, 0, 0)
    guideCtx.save()
    guideCtx.globalAlpha = 0.96
    guideCtx.drawImage(scaledMaskCanvas, 0, 0)
    guideCtx.restore()

    return await uploadCanvasAsset(guideCanvas, 'mask-focus-guide.png', '生成局部编辑引导图失败')
  }, [activeBaseImageUrl, getContainedImageRect, loadImageElement, maskDirty, maskEnabled, uploadCanvasAsset])

  const exportResizedImage = React.useCallback(async (): Promise<string> => {
    if (!isRemoteUrl(activeBaseImageUrl)) {
      throw new Error('请先上传主图到可访问的链接，再进行尺寸调整')
    }
    const image = await loadImageElement(activeBaseImageUrl)
    const canvas = document.createElement('canvas')
    canvas.width = selectedSizeDimensions.width
    canvas.height = selectedSizeDimensions.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 初始化失败')
    const scale = Math.max(
      canvas.width / Math.max(1, image.naturalWidth),
      canvas.height / Math.max(1, image.naturalHeight),
    )
    const sourceWidth = Math.max(1, Math.round(canvas.width / scale))
    const sourceHeight = Math.max(1, Math.round(canvas.height / scale))
    const sx = Math.max(0, Math.round((image.naturalWidth - sourceWidth) / 2))
    const sy = Math.max(0, Math.round((image.naturalHeight - sourceHeight) / 2))
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(
      image,
      sx,
      sy,
      Math.min(sourceWidth, image.naturalWidth - sx),
      Math.min(sourceHeight, image.naturalHeight - sy),
      0,
      0,
      canvas.width,
      canvas.height,
    )
    return await uploadCanvasAsset(
      canvas,
      `image-resize-${selectedSizeDimensions.label}.png`,
      '导出尺寸调整图片失败',
    )
  }, [activeBaseImageUrl, loadImageElement, selectedSizeDimensions.label, selectedSizeDimensions.width, selectedSizeDimensions.height, uploadCanvasAsset])

  const handleApply = React.useCallback(async () => {
    const canvas = canvasRef.current
    if (editMode === 'pose' && !canvas) {
      toast('姿势画布未就绪，请重试', 'error')
      return
    }
    if (!isRemoteUrl(activeBaseImageUrl)) {
      toast('主图不是在线地址，将仅上传参考图/圈选，推荐先上传到可访问的链接', 'warning')
    }
    setUploading(true)
    try {
      const mergedPrompt = (editMode === 'depth' ? descriptionText : promptInput).trim() || (options.promptValue || '')
      if (mergedPrompt && options.onPromptSave) {
        options.onPromptSave(mergedPrompt)
      }
      if (editMode === 'size') {
        const canvasResizeSize = `${selectedSizeDimensions.width}x${selectedSizeDimensions.height}`
        options.onCanvasResizeSizeChange?.(canvasResizeSize)
        const resizedImageUrl = await exportResizedImage()
        options.updateNodeData(options.nodeId, {
          canvasResizeSize,
          poseMaskUrl: null,
        })
        options.onPoseSaved?.({
          mode: 'size',
          poseStickmanUrl: null,
          poseReferenceImages: [resizedImageUrl],
          baseImageUrl: activeBaseImageUrl,
          prompt: mergedPrompt,
          imageEditSize: canvasResizeSize,
          resizedImageUrl,
        })
        toast('尺寸调整已生成新图', 'success')
        setOpen(false)
        return
      }
      options.onImageEditSizeChange?.(selectedImageEditSize)
      let remoteUrl: string | null = null
      if (editMode === 'pose') {
        remoteUrl = await uploadCanvasAsset(canvas!, 'pose-stickman.png', '生成参考图失败')
      }

      let maskUrl: string | null = null
      if (maskEnabled && maskDirty) {
        maskUrl = await createMaskFocusGuideUrl()
      }

      const refs = Array.from(
        new Set(
          [
            activeBaseImageUrl.trim(),
            remoteUrl?.trim() || null,
            ...(options.poseReferenceImages || []).filter(isRemoteUrl),
          ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
        ),
      ).slice(0, 3)
      options.updateNodeData(options.nodeId, {
        poseStickmanUrl: remoteUrl,
        poseReferenceImages: refs,
        poseMaskUrl: maskUrl,
      })
      if (options.onPoseSaved) {
        options.onPoseSaved({
          mode: editMode,
          poseStickmanUrl: remoteUrl,
          poseReferenceImages: refs,
          baseImageUrl: activeBaseImageUrl,
          maskUrl,
          prompt: mergedPrompt,
          imageEditSize: selectedImageEditSize,
        })
      }
      toast('图片编辑参考已保存，将作为 Nano Banana 图像编辑参考', 'success')
      setOpen(false)
    } catch (err: any) {
      console.error('handleApplyPose error', err)
      toast(err?.message || '图片编辑参考保存失败', 'error')
    } finally {
      setUploading(false)
    }
  }, [activeBaseImageUrl, options, maskDirty, promptInput, editMode, descriptionText, selectedImageEditSize, exportResizedImage, maskEnabled, createMaskFocusGuideUrl, uploadCanvasAsset])

  /**
   * 把上游给的节点图片地址解析成服务端可直接拉取的 http(s) 地址。
   *
   * <p>lens 模式下画布节点里的图片可能以 `asset://<id>` 形式保存（资源运行时标识）。
   * 这里只做**协议识别**：`asset://` 视为「与节点主图同一个资源」，主图是 http(s) 时才取其地址；
   * 其它非 http(s) 协议一律不猜，返回空串交给调用方显式失败。
   *
   * @param targetUrl 节点图片地址（可能为 asset:// 等运行时标识）
   * @returns 可用于图像理解的 http(s) 地址；无法确定时返回空串
   */
  const resolveUnderstandImageUrl = React.useCallback((targetUrl: string): string => {
    const trimmed = (targetUrl || '').trim()
    if (isRemoteUrl(trimmed)) return trimmed
    if (/^asset:\/\//i.test(trimmed)) {
      const base = (activeBaseImageUrl || '').trim()
      return isRemoteUrl(base) ? base : ''
    }
    return ''
  }, [activeBaseImageUrl])

  /**
   * 反推画面描述：按运行模式请求「图片 → 自然语言画面描述」。
   *
   * <p>lens 模式调用 lens 后端同步接口 {@link understandImage}（由后端按智能分析数据源池做多模态理解，
   * 成功后才计费，返回自然语言正文）；非 lens 模式保持原 `/public/tasks`（kind=image_to_prompt）链路。
   *
   * @param rawImageUrl 节点图片地址（可含 asset:// 等运行时标识）
   * @returns 模型输出的画面描述正文（自然语言）
   */
  const requestImageDescription = React.useCallback(async (rawImageUrl: string): Promise<string> => {
    const ui = useUIStore.getState()
    const apiKey = (ui.publicApiKey || '').trim()
    const token = getAuthToken()
    // 服务端只能拉取可访问的在线图片；local/blob/asset 未解析成 http(s) 时显式失败，不做本地猜测
    const imageUrl = resolveUnderstandImageUrl(rawImageUrl)
    if (!imageUrl) {
      throw new Error('当前图片不是可访问的在线地址，请先上传主图后再反推画面描述')
    }
    if (!isLensMode() && !apiKey && !token) {
      throw new Error('请先登录后再试')
    }
    if (isLensMode()) {
      const result = await understandImage({ imageUrl })
      return result.text
    }
    const taskRes = await runPublicTask(apiKey, {
      request: {
        kind: 'image_to_prompt',
        prompt:
          '请仔细观察这张图片，用一段自然语言把它反推成可以直接用于生图的画面描述，依次覆盖：主体（人物/物体及外观特征）、动作与姿态、场景与环境、空间层次（前景/中景/背景）、构图与机位、光影与色调、材质与质感、风格与画质。语言通顺具体，只输出这段描述正文，不要输出 JSON、键值对、解释或代码块。',
        extras: {
          imageUrl,
          nodeId: options.nodeId,
          persistAssets: ui.assetPersistenceEnabled,
        },
      },
    })
    return extractTextFromTaskResult(taskRes.result)
  }, [options.nodeId, resolveUnderstandImageUrl])

  const handleGenerateDescription = React.useCallback(async () => {
    if (!isRemoteUrl(activeBaseImageUrl)) {
      toast('请先上传主图到可访问的链接再进行局部修改', 'error')
      return
    }
    setDescriptionLoading(true)
    setDescriptionError(null)
    try {
      // 与图片节点工具栏的「AI 润色」一致：直接使用模型返回的自然语言正文，
      // 不再做 JSON 解析/格式化，也不再发起二次「结构化细分」请求。
      const text = (await requestImageDescription(activeBaseImageUrl)).trim()
      if (!text) {
        throw new Error('未返回可用的画面描述')
      }
      setDescriptionText(text)
    } catch (err: any) {
      const message = err?.message || '局部修改失败'
      setDescriptionError(message)
      toast(message, 'error')
    } finally {
      setDescriptionLoading(false)
    }
  }, [activeBaseImageUrl, requestImageDescription])

  const modal = open ? (
    <Modal
      className="pose-editor__modal"
      opened={open}
      onClose={() => setOpen(false)}
      title={(
        <Group className="pose-editor__header" gap={10} align="center" justify="space-between" wrap="nowrap">
          <Text className="pose-editor__title" size="md" fw={700}>
            编辑模式
          </Text>
          <SegmentedControl
            className="pose-editor__mode"
            size="sm"
            value={editMode}
            onChange={(value) => setEditMode(value as 'pose' | 'depth' | 'size')}
            data={[
              { value: 'pose', label: '姿势调整' },
              { value: 'depth', label: '局部修改' },
              { value: 'size', label: '尺寸调整' },
            ]}
            styles={{
              label: { color: options.isDarkUi ? '#e2e8f0' : '#0f172a' },
            }}
          />
        </Group>
      )}
      centered
      size={1100}
      withinPortal
      zIndex={320}
    >
      <Stack className="pose-editor__content" gap="sm">
        <Text className="pose-editor__intro" size="xs" c="dimmed">
          {editMode === 'pose'
            ? '使用方法：拖动火柴人指定新的动作参考，再补充提示词。姿势模式只使用火柴人参考，不支持局部圈选。'
            : editMode === 'depth'
              ? '使用方法：先在原图上圈出需要修改的区域，再编辑画面描述（可点「反推画面描述」自动生成）。圈选会转成高亮引导图，模型只修改该区域，其余保持原样。'
              : '使用方法：选择目标尺寸后，本地按目标比例居中裁切导出新图，不加黑边，不调用任何生图接口。'}
        </Text>
        <Group className="pose-editor__panels" align="flex-start" gap="md" grow>
          <Stack className="pose-editor__panel" gap={8} style={{ height: EDIT_PANEL_HEIGHT }}>
            <Group className="pose-editor__panel-header" gap={8} align="center">
              <Text className="pose-editor__panel-title" size="sm" fw={600}>
                {maskEnabled ? '原图圈选（可选）' : '原图预览'}
              </Text>
              {editMode === 'size' ? (
                <Badge className="pose-editor__panel-badge" size="xs" variant="outline" color="gray">
                  仅用于观察原图
                </Badge>
              ) : editMode === 'pose' ? (
                <Badge className="pose-editor__panel-badge" size="xs" variant="outline" color="gray">
                  姿势模式不支持圈选
                </Badge>
              ) : (
                <Badge className="pose-editor__panel-badge" size="xs" variant="outline" color="orange">
                  仅修改圈选区域
                </Badge>
              )}
            </Group>
            <div
              className="pose-editor__mask-canvas"
              style={{
                position: 'relative',
                width: POSE_CANVAS_SIZE.width,
                height: POSE_CANVAS_SIZE.height,
                borderRadius: 12,
                border: `1px solid ${options.inlineDividerColor}`,
                overflow: 'hidden',
                background: options.isDarkUi ? 'rgba(5,8,16,0.9)' : 'rgba(245,248,255,0.95)',
              }}
            >
              {poseReady ? (
                <img
                  className="pose-editor__base-image"
                  src={activeBaseImageUrl}
                  alt="base"
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'contain',
                    pointerEvents: 'none',
                    position: 'absolute',
                    inset: 0,
                  }}
                />
              ) : (
                <Text className="pose-editor__base-empty" size="xs" c="dimmed" style={{ padding: 12 }}>
                  未找到在线主图，请先上传到可访问的地址
                </Text>
              )}
              {maskEnabled ? (
                <canvas
                  className="pose-editor__mask-layer"
                  ref={maskCanvasRef}
                  width={POSE_CANVAS_SIZE.width}
                  height={POSE_CANVAS_SIZE.height}
                  style={{
                    position: 'absolute',
                    inset: 0,
                    cursor: maskDrawing ? 'crosshair' : 'cell',
                    zIndex: 2,
                    pointerEvents: 'auto',
                  }}
                  onMouseDown={(e) => handleMaskPointer(e, 'down')}
                  onMouseMove={(e) => handleMaskPointer(e, 'move')}
                  onMouseUp={(e) => handleMaskPointer(e, 'up')}
                  onMouseLeave={(e) => handleMaskPointer(e, 'up')}
                />
              ) : null}
            </div>
            {maskEnabled ? (
              <Group className="pose-editor__panel-actions" gap={6}>
                <Button className="pose-editor__clear-mask" variant="subtle" size="xs" onClick={clearMask} disabled={!maskDirty}>
                  清除圈选
                </Button>
              </Group>
            ) : editMode === 'pose' ? (
              <Text className="pose-editor__size-preview-note" size="xs" c="dimmed">
                姿势调整只会提交火柴人参考和提示词，不会提交局部涂抹区域。
              </Text>
            ) : (
              <Text className="pose-editor__size-preview-note" size="xs" c="dimmed">
                导出时会按目标比例居中裁切，完整填满画面，不再补黑边。
              </Text>
            )}
          </Stack>
          <Stack className="pose-editor__panel" gap={8} style={{ height: EDIT_PANEL_HEIGHT }}>
              {editMode === 'pose' ? (
                <>
                  <Stack className="pose-editor__panel-stack" gap={8}>
                    <Group className="pose-editor__panel-header" gap={8} align="center">
                      <Text className="pose-editor__panel-title" size="sm" fw={600}>
                        火柴人参考（必选）
                      </Text>
                      <Badge className="pose-editor__panel-badge" size="xs" variant="light">
                        必选
                      </Badge>
                    </Group>
                    <canvas
                      className="pose-editor__pose-canvas"
                      ref={canvasRef}
                      width={POSE_CANVAS_SIZE.width}
                      height={POSE_CANVAS_SIZE.height}
                      style={{
                        width: POSE_CANVAS_SIZE.width,
                        height: POSE_CANVAS_SIZE.height,
                        borderRadius: 12,
                        border: `1px solid ${options.inlineDividerColor}`,
                        background: options.isDarkUi ? 'rgba(5,8,16,0.92)' : 'rgba(245,248,255,0.95)',
                        cursor: draggingIndex !== null ? 'grabbing' : 'grab',
                      }}
                      onMouseDown={(e) => handlePointer(e, 'down')}
                      onMouseMove={(e) => handlePointer(e, 'move')}
                      onMouseUp={(e) => handlePointer(e, 'up')}
                      onMouseLeave={(e) => handlePointer(e, 'up')}
                    />
                    <Textarea
                      className="pose-editor__pose-prompt"
                      label="补充提示词"
                      placeholder="示例：保持原衣着，只调整手部动作；光影延续原图"
                      autosize
                      minRows={2}
                      maxRows={4}
                      value={promptInput}
                      onChange={(e) => setPromptInput(e.currentTarget.value)}
                    />
                  </Stack>
                  <div className="pose-editor__spacer" style={{ flex: 1 }} />
                  <Group className="pose-editor__panel-actions" gap={6}>
                    <Button
                      className="pose-editor__reset-pose"
                      variant="subtle"
                      size="xs"
                      onClick={() => setPoints(createDefaultPosePoints())}
                    >
                      重置火柴人
                    </Button>
                    <Tooltip className="pose-editor__save-tooltip" label="保存火柴人参考和提示词，并原位更新当前镜头">
                      <Button
                        className="pose-editor__save"
                        size="xs"
                        leftSection={<IconAdjustments size={14} />}
                        onClick={handleApply}
                        loading={uploading}
                      >
                        保存并生成
                      </Button>
                    </Tooltip>
                  </Group>
                </>
              ) : editMode === 'depth' ? (
                <>
                  <Stack className="pose-editor__panel-stack" gap={8}>
                    <Text className="pose-editor__panel-title" size="sm" fw={600}>
                      画面描述（可编辑）
                    </Text>
                    <Text
                      className="pose-editor__depth-hint"
                      size="xs"
                      c="dimmed"
                      style={{ color: options.isDarkUi ? 'rgba(226,232,240,0.7)' : '#475569' }}
                    >
                      点「反推画面描述」可让模型按当前图片生成一段自然语言描述（与「AI 润色」同类型），再按需要修改文字；保存后会把圈选高亮图作为局部编辑区域引导。「保存并生成」才会调用生图模型。
                    </Text>
                    <Group className="pose-editor__panel-actions" gap={6}>
                      <Button
                        className="pose-editor__generate-depth"
                        size="xs"
                        variant="light"
                        loading={descriptionLoading}
                        onClick={handleGenerateDescription}
                      >
                        反推画面描述
                      </Button>
                      {descriptionError && (
                        <Text className="pose-editor__depth-error" size="xs" c="red">
                          {descriptionError}
                        </Text>
                      )}
                    </Group>
                    <Textarea
                      className="pose-editor__depth-textarea"
                      label="画面描述"
                      placeholder="点击“反推画面描述”后在此编辑，也可以直接手写"
                      autosize
                      minRows={4}
                      maxRows={7}
                      value={descriptionText}
                      onChange={(e) => setDescriptionText(e.currentTarget.value)}
                    />
                  </Stack>
                  <div className="pose-editor__spacer" style={{ flex: 1 }} />
                  <Group className="pose-editor__panel-actions" gap={6}>
                    <Tooltip className="pose-editor__save-tooltip" label="保存圈选引导和画面描述，并原位生图更新当前镜头">
                      <Button
                        className="pose-editor__save"
                        size="xs"
                        leftSection={<IconAdjustments size={14} />}
                        onClick={handleApply}
                        loading={uploading}
                      >
                        保存并生成
                      </Button>
                    </Tooltip>
                  </Group>
                </>
              ) : (
                <>
                  <Stack className="pose-editor__panel-stack" gap={8}>
                    <Text className="pose-editor__panel-title" size="sm" fw={600}>
                      尺寸调整
                    </Text>
                    <Text
                      className="pose-editor__depth-hint"
                      size="xs"
                      c="dimmed"
                      style={{ color: options.isDarkUi ? 'rgba(226,232,240,0.7)' : '#475569' }}
                    >
                      直接用 Canvas 按目标比例裁切导出，不调用任何生图接口。
                    </Text>
                    <Select
                      className="pose-editor__size-select"
                      label="输出尺寸"
                      value={selectedCanvasResizePreset}
                      onChange={(value) => {
                        if (typeof value !== 'string' || !value.trim()) return
                        setSelectedCanvasResizePreset(value)
                        if (value !== '__custom__') {
                          const parsed = parseCanvasResizeSizeDimensions(value)
                          if (parsed) {
                            setCustomResizeWidth(parsed.width)
                            setCustomResizeHeight(parsed.height)
                          }
                        }
                      }}
                      data={[
                        ...CANVAS_RESIZE_SIZE_OPTIONS.map((item) => ({
                          value: item.value,
                          label: item.label,
                        })),
                        { value: '__custom__', label: '自定义尺寸' },
                      ]}
                      allowDeselect={false}
                    />
                    {selectedCanvasResizePreset === '__custom__' ? (
                      <Group className="pose-editor__size-custom-group" gap="sm" grow>
                        <NumberInput
                          className="pose-editor__size-custom-width"
                          label="宽度"
                          min={64}
                          max={4096}
                          step={1}
                          clampBehavior="strict"
                          value={customResizeWidth}
                          onChange={(value) => {
                            const next = typeof value === 'number' ? value : Number(value)
                            if (Number.isFinite(next)) setCustomResizeWidth(Math.max(64, Math.min(4096, Math.trunc(next))))
                          }}
                        />
                        <NumberInput
                          className="pose-editor__size-custom-height"
                          label="高度"
                          min={64}
                          max={4096}
                          step={1}
                          clampBehavior="strict"
                          value={customResizeHeight}
                          onChange={(value) => {
                            const next = typeof value === 'number' ? value : Number(value)
                            if (Number.isFinite(next)) setCustomResizeHeight(Math.max(64, Math.min(4096, Math.trunc(next))))
                          }}
                        />
                      </Group>
                    ) : null}
                    <div
                      className="pose-editor__size-preview-stage"
                      style={{
                        width: POSE_CANVAS_SIZE.width,
                        height: POSE_CANVAS_SIZE.height,
                        borderRadius: 12,
                        border: `1px solid ${options.inlineDividerColor}`,
                        background: options.isDarkUi ? 'rgba(5,8,16,0.92)' : 'rgba(245,248,255,0.95)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        overflow: 'hidden',
                      }}
                    >
                      {poseReady ? (
                        <div
                          className="pose-editor__size-preview-shell"
                          style={{
                            width: '88%',
                            aspectRatio: `${selectedSizeDimensions.width} / ${selectedSizeDimensions.height}`,
                            background: options.isDarkUi ? 'rgba(15,23,42,0.92)' : 'rgba(255,255,255,0.96)',
                            borderRadius: 12,
                            overflow: 'hidden',
                            boxShadow: options.isDarkUi ? '0 10px 28px rgba(0,0,0,0.28)' : '0 10px 24px rgba(148,163,184,0.28)',
                          }}
                        >
                          <img
                            className="pose-editor__size-preview-stage-image"
                            src={activeBaseImageUrl}
                            alt={selectedSizeDimensions.label}
                            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                          />
                        </div>
                      ) : (
                        <Text className="pose-editor__size-preview-stage-empty" size="xs" c="dimmed">
                          未找到在线主图
                        </Text>
                      )}
                    </div>
                  </Stack>
                  <div className="pose-editor__spacer" style={{ flex: 1 }} />
                  <Group className="pose-editor__panel-actions" gap={6}>
                    <Tooltip className="pose-editor__save-tooltip" label="仅导出当前尺寸新图，不调用任何生图接口">
                      <Button
                        className="pose-editor__save"
                        size="xs"
                        leftSection={<IconAdjustments size={14} />}
                        onClick={handleApply}
                        loading={uploading}
                      >
                        保存新图
                      </Button>
                    </Tooltip>
                  </Group>
                </>
              )}
            </Stack>
        </Group>
        <Text className="pose-editor__note" size="xs" c="dimmed" style={{ whiteSpace: 'normal' }}>
          {editMode === 'pose'
            ? '效果：火柴人姿势和补充提示词会引导模型重排人物动作，不支持局部圈选。'
            : editMode === 'depth'
              ? '效果：最后一张参考图会作为局部编辑区域引导图，模型必须保留整张原图，只允许修改高亮区域。'
              : '尺寸调整只做本地导出与上传，不触发远端图像编辑任务。'}
        </Text>
      </Stack>
    </Modal>
  ) : null

  return {
    open: openEditor,
    modal,
    poseReady,
    setOpen,
  }
}
