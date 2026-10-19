/**
 * 画布 lens 投影资产节点（角色／场景／道具）的尺寸常量。
 *
 * 独立成模块：LensCanvasApp 依赖 TaskNode，测试与引用模块只应拿到常量，
 * 不应把整页组件及其依赖链一起加载进来。
 */
/** 图片内容高度；TaskNode 会同时用于图片容器高度 */
export const LENS_ASSET_MEDIA_HEIGHT = 250
/** 节点横向宽度，与投影节点保持一致 */
export const LENS_ASSET_NODE_WIDTH = 384
