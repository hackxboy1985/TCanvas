/**
 * OSS 响应式图片工具（借鉴 liblib：按显示宽度选不同缩放档位，画布放大时才拉大图）
 *
 * 阿里云 OSS 图片处理参数：?x-oss-process=image/resize,w_{宽度}，
 * 与 lens 前端（PropListPage/RoleManagerPage 等）及 liblib 同款。
 */

/** 缩放档位（宽度，px） */
const OSS_RESIZE_WIDTHS = [100, 200, 400, 800, 1600] as const

/** 按显示宽度选择最小满足的档位；超出最大档则用最大档 */
export function pickOssResizeWidth(displayWidthPx: number): number {
  const width = Math.max(1, Math.round(displayWidthPx))
  return OSS_RESIZE_WIDTHS.find((w) => w >= width) ?? OSS_RESIZE_WIDTHS[OSS_RESIZE_WIDTHS.length - 1]
}

/**
 * 把图片 URL 换成按显示宽度选档位的 OSS 缩略图 URL。
 * 已带 x-oss-process 参数、或非 HTTP 链接（data:/blob:）时原样返回。
 */
export function toOssResponsiveUrl(url: string, displayWidthPx: number): string {
  if (!url) return ''
  if (url.startsWith('data:') || url.startsWith('blob:')) return url
  if (url.includes('x-oss-process')) return url
  const width = pickOssResizeWidth(displayWidthPx)
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}x-oss-process=image/resize,w_${width}`
}

/** 节点内图片的实际显示宽度（画布缩放 + 设备像素比，2x 屏按 2 倍取档位） */
export function computeNodeImageDisplayWidth(nodeWidth: number, zoom: number): number {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  return nodeWidth * zoom * dpr
}
