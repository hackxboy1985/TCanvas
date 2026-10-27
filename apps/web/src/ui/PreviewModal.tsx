import React, { useEffect, useState } from 'react'
import { ActionIcon, Button, Group, Title, Portal } from '@mantine/core'
import { IconX, IconDownload, IconPhoto } from '@tabler/icons-react'
import { useUIStore } from './uiStore'
import { appendDownloadSuffix, downloadUrl } from '../utils/download'
import { toOssResponsiveUrl } from '../canvas/utils/ossResponsive'

export default function PreviewModal({ className }: { className?: string }): JSX.Element | null {
  const preview = useUIStore(s => s.preview)
  const close = useUIStore(s => s.closePreview)
  const previewUrl = preview?.url ?? null
  const previewKind = preview?.kind ?? null

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  // 是否展示原图：默认关闭（展示 OSS 压缩图，加载快）
  const [showOriginal, setShowOriginal] = useState(false)

  // 切换预览对象时回到压缩图
  useEffect(() => {
    setShowOriginal(false)
  }, [previewUrl])

  // 目标地址：原图 or OSS 压缩图
  // 压缩档位按「视口宽度 × 设备像素比」选取（2x 屏取更高档），档位上限 1600，
  // 既保证 4K 屏清晰度，又避免直接拉 4K 原图
  const previewTargetSrc = React.useMemo(() => {
    if (previewKind !== 'image' || !previewUrl) return ''
    if (showOriginal) return previewUrl
    const viewportWidth = typeof window === 'undefined' ? 1600 : window.innerWidth
    const dpr = typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, 2)
    return toOssResponsiveUrl(previewUrl, Math.round(viewportWidth * 0.92 * dpr))
  }, [previewKind, previewUrl, showOriginal])

  if (!preview) return null
  const { url, kind, name } = preview
  const download = () => {
    void downloadUrl({
      url,
      filename: name ? appendDownloadSuffix(name, Date.now()) : `tapcanvas-${kind}-${Date.now()}`,
      preferBlob: true,
      fallbackTarget: '_blank',
    })
  }

  const overlayClassName = ['preview-modal', className].filter(Boolean).join(' ')

  return (
    <Portal className="preview-modal-portal" zIndex={400}>
      <div
        className={overlayClassName}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,.85)',
          zIndex: 9999,
          display: 'grid',
          gridTemplateRows: 'auto 1fr',
          color: '#e5e7eb',
        }}
      >
        <div
          className="preview-modal-header"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: 10,
          }}
        >
          <Title className="preview-modal-title" order={5} style={{ color: '#e5e7eb' }}>
            {name || '预览'}
          </Title>
          <Group className="preview-modal-actions" gap={6}>
            {kind === 'image' && (
              <Button
                className="preview-modal-original-toggle"
                variant="light"
                size="compact-sm"
                leftSection={<IconPhoto size={14} />}
                onClick={() => setShowOriginal((prev) => !prev)}
                title={showOriginal ? '切换回压缩图' : '加载并展示原图'}
              >
                {showOriginal ? '显示压缩图' : '展示原图'}
              </Button>
            )}
            <ActionIcon className="preview-modal-download" variant="light" onClick={download} title="下载">
              <IconDownload className="preview-modal-download-icon" size={16} />
            </ActionIcon>
            <ActionIcon className="preview-modal-close" variant="light" onClick={close} title="关闭">
              <IconX className="preview-modal-close-icon" size={16} />
            </ActionIcon>
          </Group>
        </div>
        <div
          className="preview-modal-body"
          style={{ display: 'grid', placeItems: 'center', padding: 12 }}
          onClick={close}
        >
          <div
            className="preview-modal-content"
            onClick={(e) => e.stopPropagation()}
          >
            {kind === 'image' && (
              <img
                className="preview-modal-image"
                src={previewTargetSrc || url}
                decoding="async"
                loading="eager"
                alt={name || 'preview'}
                style={{
                  maxWidth: '92vw',
                  maxHeight: '82vh',
                  borderRadius: 8,
                  boxShadow: '0 12px 40px rgba(0,0,0,.45)',
                  border: '1px solid rgba(255,255,255,.12)',
                }}
              />
            )}
            {kind === 'video' && (
              <video
                className="preview-modal-video"
                src={url}
                controls
                autoPlay
                style={{
                  maxWidth: '92vw',
                  maxHeight: '82vh',
                  borderRadius: 8,
                  boxShadow: '0 12px 40px rgba(0,0,0,.45)',
                  border: '1px solid rgba(255,255,255,.12)',
                }}
              />
            )}
            {kind === 'audio' && (
              <audio className="preview-modal-audio" src={url} controls style={{ width: '60vw' }} />
            )}
          </div>
        </div>
      </div>
    </Portal>
  )
}
