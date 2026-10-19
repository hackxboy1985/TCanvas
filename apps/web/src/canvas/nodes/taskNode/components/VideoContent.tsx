import React from 'react'
import { Button, Group, Text, Tooltip } from '@mantine/core'
import { IconCheck, IconClock, IconScissors } from '@tabler/icons-react'
import type { FrameSample } from '../types'
import { VideoFramePreview } from './VideoFramePreview'

type VideoResult = {
  url: string
  thumbnailUrl?: string | null
  title?: string | null
  duration?: number
}

type VideoContentProps = {
  videoResults: VideoResult[]
  videoPrimaryIndex: number
  adoptedVideoIndex: number | null
  isPrimaryVideoAdopted: boolean
  videoUrl: string | null
  videoThumbnailUrl?: string | null
  videoTitle?: string | null
  videoSurface: string
  mediaOverlayBackground: string
  mediaOverlayText: string
  mediaFallbackText: string
  mediaFallbackSurface: string
  inlineDividerColor: string
  accentPrimary: string
  rgba: (color: string, alpha: number) => string
  /** 视频时长（秒）：供抽帧预览计算抽帧时间点 */
  videoDurationSeconds: number | null
  /** 抽帧预览的提示出口（沿用节点的 toast） */
  onFramePreviewNotify: (message: string, level: 'success' | 'error') => void
  onAdoptVideo: (index: number) => void
  onOpenVideoModal: () => void
  onOpenWebCut?: () => void
}

export function VideoContent({
  videoResults,
  videoPrimaryIndex,
  adoptedVideoIndex,
  isPrimaryVideoAdopted,
  videoUrl,
  videoThumbnailUrl,
  videoTitle,
  videoSurface,
  mediaOverlayBackground,
  mediaOverlayText,
  mediaFallbackText,
  mediaFallbackSurface,
  inlineDividerColor,
  accentPrimary,
  rgba,
  videoDurationSeconds,
  onFramePreviewNotify,
  onAdoptVideo,
  onOpenVideoModal,
  onOpenWebCut,
}: VideoContentProps) {
  const canClip = Boolean(videoResults[videoPrimaryIndex]?.url || videoUrl)
  // 抽帧预览的视频源：优先主视频结果，其次节点上的视频地址
  const framePreviewVideoUrl = String(videoResults[videoPrimaryIndex]?.url || videoUrl || '').trim()
  return (
    <div
      className="video-content"
      style={{
        width: '100%',
        height: '100%',
        minHeight: 0,
        borderRadius: 10,
        background: mediaOverlayBackground,
        padding: 8,
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        gap: 6,
        color: mediaOverlayText,
      }}
    >
      <Group className="video-content-header" justify="space-between" gap={4}>
        <Text className="video-content-header-text" size="xs" c="dimmed">
          {videoResults.length > 0
            ? `共 ${videoResults.length} 个视频${videoPrimaryIndex >= 0 ? ` (主视频: 第 ${videoPrimaryIndex + 1} 个)` : ''}`
            : '视频生成中...'}
        </Text>
	        <Group className="video-content-header-actions" gap={2}>
            {videoResults[videoPrimaryIndex]?.url && (
              <Tooltip label={isPrimaryVideoAdopted ? '当前主视频已采纳' : '采纳当前主视频'} position="top" withArrow>
                <Button
                  className="video-content-adopt-button"
                  size="compact-xs"
                  variant={isPrimaryVideoAdopted ? 'filled' : 'subtle'}
                  color="red"
                  onClick={() => onAdoptVideo(videoPrimaryIndex)}
                  leftSection={<IconCheck className="video-content-adopt-icon" size={12} />}
                >
                  采纳
                </Button>
              </Tooltip>
            )}
	          <Button
            className="video-content-clip-button"
            size="compact-xs"
            variant="subtle"
            disabled={!canClip || !onOpenWebCut}
            onClick={onOpenWebCut}
            leftSection={<IconScissors className="video-content-clip-icon" size={12} />}
	          >
	            剪辑
	          </Button>
	          <Button
	            className="video-content-history-button"
	            size="compact-xs"
            variant="subtle"
            onClick={onOpenVideoModal}
            leftSection={<IconClock className="video-content-history-icon" size={12} />}
          >
            {videoResults.length > 0 ? '选择主视频' : '查看历史'}
          </Button>
        </Group>
      </Group>

      {/* 抽帧预览：与分镜视频节点共用同一组件，保证交互与产出一致 */}
      <VideoFramePreview
        className="video-content-actions-row"
        videoUrl={framePreviewVideoUrl}
        durationSeconds={videoDurationSeconds}
        onNotify={onFramePreviewNotify}
      />

      {videoUrl ? (
        <video
          className="video-content-player"
          src={videoResults[videoPrimaryIndex]?.url || videoUrl}
          poster={videoResults[videoPrimaryIndex]?.thumbnailUrl || videoThumbnailUrl || undefined}
          controls
          loop
          muted
          playsInline
          style={{
            borderRadius: 8,
            width: '100%',
            flex: 1,
            minHeight: 120,
            height: '100%',
            objectFit: 'cover',
            backgroundColor: videoSurface,
            boxShadow: isPrimaryVideoAdopted ? '0 0 0 2px rgba(220,38,38,0.92)' : undefined,
          }}
        />
      ) : (
        <div
          className="video-content-placeholder"
          style={{
            flex: 1,
            minHeight: 120,
            borderRadius: 8,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: mediaFallbackText,
            fontSize: 12,
          }}
        >
          等待视频生成完成…
        </div>
      )}

      {videoTitle && (
        <Text className="video-content-title" size="xs" lineClamp={1} c="dimmed">
          {videoTitle}
        </Text>
      )}
    </div>
  )
}