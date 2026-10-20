/**
 * 阿里云 OSS 视频截帧工具
 * 
 * 通过 OSS 图片处理参数直接截取视频帧，避免在浏览器端用 canvas 生成 blob URL
 */

/**
 * 判断 URL 是否为阿里云 OSS 视频地址
 */
export function isOssVideoUrl(url: string): boolean {
  if (!url) return false
  // 判断是否为阿里云 OSS 地址（支持常见的几种域名格式）
  return /\.oss-[a-z0-9-]+\.aliyuncs\.com\//i.test(url) || 
         /\.oss\.aliyuncs\.com\//i.test(url)
}

/**
 * 使用 OSS 参数截取视频帧
 * 
 * @param videoUrl 视频 URL（必须是阿里云 OSS 地址）
 * @param timeSeconds 截取时间点（秒）
 * @param options 可选参数
 * @returns 截帧后的图片 URL
 */
export function buildOssVideoSnapshotUrl(
  videoUrl: string,
  timeSeconds: number,
  options?: {
    /** 输出格式，默认 jpg */
    format?: 'jpg' | 'png'
    /** 输出宽度，0 表示保持原始宽度 */
    width?: number
    /** 输出高度，0 表示保持原始高度 */
    height?: number
    /** 截帧模式，默认 fast（快速模式） */
    mode?: 'fast' | 'accurate'
  }
): string {
  const format = options?.format || 'jpg'
  const width = options?.width ?? 0
  const height = options?.height ?? 0
  const mode = options?.mode || 'fast'
  const timeMs = Math.max(0, Math.round(timeSeconds * 1000))
  
  // 构建 OSS 图片处理参数
  const ossParams = `x-oss-process=video/snapshot,t_${timeMs},f_${format},w_${width},h_${height},m_${mode}`
  
  // 如果 URL 已经有查询参数，用 & 连接；否则用 ?
  const separator = videoUrl.includes('?') ? '&' : '?'
  
  return `${videoUrl}${separator}${ossParams}`
}
