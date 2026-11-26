/** 返回会话切换后的空输入状态；引用与候选必须和正文一起清理。 */
export function createEmptyLensChatComposerState() {
  return {
    draft: '',
    mentionedNodes: [],
    query: null,
    candidates: [],
    activeIndex: 0,
    mentionStart: -1,
    mentionCaret: 0,
  }
}

/** 只有仍有效且未被新请求替代的历史响应可以更新当前会话。 */
export function isLensChatHistoryRequestCurrent(requestVersion: number, currentVersion: number, cancelled = false): boolean {
  return !cancelled && requestVersion === currentVersion
}
