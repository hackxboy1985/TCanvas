import React from 'react'
import { Button, Group, Text } from '@mantine/core'
import { IconPhotoSearch } from '@tabler/icons-react'
import { captureFramesAtTimes } from '../../../../utils/videoFrameExtractor'
import { setTapImageDragData } from '../../../dnd/setTapImageDragData'
import { MAX_FRAME_ANALYSIS_SAMPLES } from '../../taskNodeHelpers'
import { isOssVideoUrl, buildOssVideoSnapshotUrl } from '../../../../utils/ossVideoSnapshot'
import type { FrameSample } from '../types'

type VideoFramePreviewProps = {
  /** 要抽帧的视频地址（分镜节点取 selectedImageUrl，视频节点取主视频结果） */
  videoUrl: string
  /** 视频时长（秒）：用于计算等间隔抽帧时间点，缺省时只抽第 1 秒 */
  durationSeconds: number | null
  /** 抽帧失败/成功的提示文案出口（节点外层已有 toast 能力） */
  onNotify: (message: string, level: 'success' | 'error') => void
  className?: string
}

/**
 * 视频抽帧预览。
 *
 * <p>从视频节点（TaskNode 的视频内容区）抽出的「抽帧预览 + 拖拽建图节点」能力，
 * 分镜视频节点与视频节点共用本组件，保证两处的抽帧交互与结果完全一致。
 *
 * <p>交互契约（与视频节点原有行为一致）：
 * <ol>
 *   <li>点击「抽帧预览」按视频时长等间隔抽帧（最多 {@link MAX_FRAME_ANALYSIS_SAMPLES} 帧）；</li>
 *   <li>抽出的帧以缩略图网格展示，可拖拽到画布任意位置生成图片节点；</li>
 *   <li>点「清空帧」释放本地 objectURL。</li>
 * </ol>
 */
export function VideoFramePreview({
  videoUrl,
  durationSeconds,
  onNotify,
  className,
}: VideoFramePreviewProps): JSX.Element {
  const frameSampleUrlsRef = React.useRef<string[]>([])
  const [frameSamples, setFrameSamples] = React.useState<FrameSample[]>([])
  const [frameCaptureLoading, setFrameCaptureLoading] = React.useState(false)
  const didDragFrameRef = React.useRef(false)

  /** 释放已抽取帧的本地 objectURL（避免内存泄漏） */
  const cleanupFrameSamples = React.useCallback(() => {
    frameSampleUrlsRef.current.forEach((url) => {
      try {
        URL.revokeObjectURL(url)
      } catch {
        // 忽略释放失败：objectURL 已失效时 revoke 会抛错，不影响交互
      }
    })
    frameSampleUrlsRef.current = []
    setFrameSamples([])
  }, [])

  // 卸载时释放所有帧
  React.useEffect(() => cleanupFrameSamples(), [cleanupFrameSamples])

  /** 计算抽帧时间点：按整秒等间隔采样，并额外补上末尾时间点 */
  const buildSampleTimes = React.useCallback((duration: number | null): number[] => {
    if (duration === null || !Number.isFinite(duration) || duration <= 0) return [1]
    const durationSecondsValue = Math.max(1, duration)
    const floorSeconds = Math.floor(durationSecondsValue)
    const step = floorSeconds + 1 > MAX_FRAME_ANALYSIS_SAMPLES
      ? Math.ceil((floorSeconds + 1) / MAX_FRAME_ANALYSIS_SAMPLES)
      : 1
    const times: number[] = []
    for (let second = 0; second <= floorSeconds; second += step) {
      times.push(Number(second.toFixed(2)))
    }
    const lastTime = Number(durationSecondsValue.toFixed(2))
    if (!times.includes(lastTime)) times.push(lastTime)
    return times.filter((time, index, arr) => Number.isFinite(time) && time >= 0 && arr.indexOf(time) === index)
  }, [])

  /** 抽帧主流程：优先使用 OSS 参数截帧，降级到浏览器 canvas 截帧 */
  const handleCapture = React.useCallback(async () => {
    const src = String(videoUrl || '').trim()
    if (!src) {
      onNotify('当前没有可用的视频链接', 'error')
      return
    }
    setFrameCaptureLoading(true)
    cleanupFrameSamples()
    try {
      const times = buildSampleTimes(durationSeconds)
      
      // 优先使用 OSS 参数截帧（如果是 OSS 视频）
      if (isOssVideoUrl(src)) {
        const ossFrames = times.map((timeSeconds) => ({
          url: buildOssVideoSnapshotUrl(src, timeSeconds),
          time: timeSeconds,
          blob: null as unknown as Blob,
          remoteUrl: null,
          description: null,
          describing: false,
        }))
        setFrameSamples(ossFrames)
        onNotify(`已生成 ${ossFrames.length} 帧截图 URL`, 'success')
        return
      }
      
      // 降级：使用浏览器 canvas 截帧（仅限非 OSS 视频）
      const { frames } = await captureFramesAtTimes({ type: 'url', url: src }, times)
      frameSampleUrlsRef.current = frames.map((frame) => frame.objectUrl)
      setFrameSamples(
        frames.map((frame) => ({
          url: frame.objectUrl,
          time: frame.time,
          blob: frame.blob,
          remoteUrl: null,
          description: null,
          describing: false,
        })),
      )
      if (!frames.length) {
        onNotify('未能抽取到有效帧，可能受跨域或视频格式限制', 'error')
      } else {
        onNotify(`已抽取 ${frames.length} 帧`, 'success')
      }
    } catch (error: unknown) {
      const message = error instanceof Error && error.message ? error.message : '抽帧失败，可能是跨域或视频格式不支持'
      onNotify(message, 'error')
    } finally {
      setFrameCaptureLoading(false)
    }
  }, [buildSampleTimes, cleanupFrameSamples, durationSeconds, onNotify, videoUrl])

  /** 帧拖拽：写入画布拖拽数据，落到画布后由 Canvas 生成图片节点 */
  const handleFrameDragStart = React.useCallback((evt: React.DragEvent, frame: FrameSample) => {
    didDragFrameRef.current = true
    evt.dataTransfer.effectAllowed = 'copy'
    evt.dataTransfer.setData(
      'application/tap-frame-sample',
      JSON.stringify({ url: frame.url, remoteUrl: null, time: frame.time }),
    )
    setTapImageDragData(evt, frame.url)
  }, [])

  return (
    <div className={['video-frame-preview', className].filter(Boolean).join(' ')} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Group className="video-frame-preview-actions" gap={6} justify="space-between">
        <Button
          className="video-frame-preview-capture"
          size="compact-xs"
          variant="light"
          leftSection={<IconPhotoSearch className="video-frame-preview-capture-icon" size={12} />}
          loading={frameCaptureLoading}
          onClick={() => void handleCapture()}
        >
          抽帧预览
        </Button>
        {frameSamples.length > 0 && (
          <Button className="video-frame-preview-clear" size="compact-xs" variant="subtle" onClick={cleanupFrameSamples}>
            清空帧
          </Button>
        )}
      </Group>

      {frameSamples.length > 0 && (
        <div
          className="video-frame-preview-grid"
          style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(72px, 1fr))', gap: 6 }}
        >
          {frameSamples.map((frame) => (
            <div
              className="video-frame-preview-card nodrag nopan"
              key={`${frame.url}-${frame.time}`}
              style={{ display: 'flex', flexDirection: 'column', gap: 4, cursor: 'grab' }}
              title="拖拽到画布生成图片节点"
              draggable
              onMouseDown={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onDragStart={(evt) => handleFrameDragStart(evt, frame)}
              onDragEnd={() => {
                didDragFrameRef.current = false
              }}
            >
              <div
                className="video-frame-preview-thumb nodrag nopan"
                style={{
                  borderRadius: 8,
                  overflow: 'hidden',
                  background: 'rgba(127,127,127,0.16)',
                  border: '1px solid rgba(127,127,127,0.24)',
                  width: '100%',
                  aspectRatio: '4 / 3',
                }}
              >
                <img
                  className="video-frame-preview-img nodrag nopan"
                  src={frame.url}
                  alt={`frame-${frame.time.toFixed(2)}s`}
                  draggable
                  onMouseDown={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  onDragStart={(evt) => handleFrameDragStart(evt, frame)}
                  onDragEnd={() => {
                    didDragFrameRef.current = false
                  }}
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
              </div>
              <Text className="video-frame-preview-time" size="xs" c="dimmed">
                {frame.time.toFixed(2)}s
              </Text>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
