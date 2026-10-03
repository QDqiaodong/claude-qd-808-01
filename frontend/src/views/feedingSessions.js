import { computed, reactive, ref } from 'vue'

/**
 * 投料倒计时状态。
 *
 * 切换批次会主动放弃旧批次的称量：后端把投料明细恢复到待投/异常，前端关闭计时和弹窗。
 * 这里不按批次各自保留倒计时，因为倒计时结束会立即弹出称重框，保留旧计时会在用户操作
 * 新批次时打断并造成串批；主动放弃更符合现场防误操作的优先级。
 */
export function useFeedingSessions (options = {}) {
  const {
    totalSeconds = 5,
    setIntervalFn = globalThis.setInterval,
    clearIntervalFn = globalThis.clearInterval,
    weighRequest,
    cancelRequest
  } = options

  // entries 必须保留原始对象；Vue reactive 会代理对象，异步回调从 Map 取回代理后会丢失
  // pendingRequests 中保存的标记引用，因此版本号单独承担模板响应式触发。
  const entriesByKey = new Map()
  const pendingRequests = new Map()
  const version = ref(0)
  const dialog = reactive({
    visible: false,
    batchId: null,
    itemId: null,
    feedSeq: null,
    item: null,
    busy: false,
    closing: false,
    aborted: false,
    batchNo: null
  })

  function touch () {
    version.value += 1
  }

  function sessionKey (batchId, feedSeq) {
    return `${batchId}:${feedSeq}`
  }

  function getEntry (batchId, feedSeq) {
    return entriesByKey.get(sessionKey(batchId, feedSeq))
  }

  const sessions = computed(() => {
    void version.value
    return Object.fromEntries(entriesByKey)
  })

  function countdownFor (batchId, feedSeq) {
    void version.value
    return getEntry(batchId, feedSeq)?.remaining || 0
  }

  const isDialogOpen = computed(() => dialog.visible)

  function clearTimer (entry) {
    if (entry.timer) {
      clearIntervalFn(entry.timer)
      entry.timer = null
    }
  }

  function closeDialog () {
    dialog.visible = false
    dialog.batchId = null
    dialog.itemId = null
    dialog.item = null
    dialog.feedSeq = null
    dialog.busy = false
    dialog.closing = false
    dialog.aborted = false
    dialog.batchNo = null
  }

  function openDialog (batchId, item, entry, batchNo = null) {
    clearTimer(entry)
    entry.remaining = 0
    touch()
    dialog.batchId = batchId
    dialog.itemId = item.id
    dialog.feedSeq = item.feedSeq
    dialog.item = item
    dialog.batchNo = batchNo
    dialog.visible = true
  }

  function removeEntry (entry) {
    clearTimer(entry)
    if (entriesByKey.get(entry.key) === entry) entriesByKey.delete(entry.key)
    touch()
  }

  function startTimer (batchId, item, entry, batchNo = null) {
    entry.timer = setIntervalFn(() => {
      if (entry.cancelled) {
        clearTimer(entry)
        return
      }

      entry.remaining -= 1
      if (entry.remaining <= 0) {
        if (entry.cancelled) {
          removeEntry(entry)
          return
        }
        openDialog(batchId, item, entry, batchNo)
      } else {
        touch()
      }
    }, 1000)
  }

  async function startWeigh (batchId, item, batchNo = null) {
    if (!weighRequest) return
    const key = sessionKey(batchId, item.feedSeq)
    if (entriesByKey.has(key)) return

    const entry = {
      key,
      batchId,
      feedSeq: item.feedSeq,
      itemId: item.id,
      item,
      remaining: totalSeconds,
      timer: null,
      pending: true,
      cancelled: false,
      discarded: false,
      started: false,
      failed: false
    }
    entriesByKey.set(key, entry)
    touch()

    let request
    const pending = {
      entry,
      get request () {
        return request
      },
      hasStarted: () => entry.started
    }

    try {
      request = weighRequest(batchId, item.feedSeq)
      pendingRequests.set(key, pending)
      await request
      entry.started = true
    } catch (err) {
      entry.failed = true
      if (entriesByKey.get(key) === entry) entriesByKey.delete(key)
      touch()
      throw err
    } finally {
      if (pendingRequests.get(key) === pending) pendingRequests.delete(key)
    }

    if (entry.cancelled || entry.discarded || entriesByKey.get(key) !== entry) return
    entry.pending = false
    startTimer(batchId, item, entry, batchNo)
  }

  async function cancelSession (batchId, feedSeq) {
    const entry = getEntry(batchId, feedSeq)
    if (!entry) return

    if (dialog.visible && dialog.batchId === batchId && dialog.feedSeq === feedSeq) {
      closeDialog()
    }

    entry.cancelled = true
    removeEntry(entry)
    if (cancelRequest) await cancelRequest(batchId, feedSeq)
  }

  async function discardBatch (batchId) {
    const entries = [...entriesByKey.values()].filter(entry => entry.batchId === batchId)
    const pending = [...pendingRequests.values()].filter(item => item.entry.batchId === batchId)
    if (!entries.length && dialog.batchId !== batchId) return

    const hadDialog = dialog.batchId === batchId
    if (hadDialog) closeDialog()

    for (const entry of entries) {
      entry.cancelled = true
      entry.discarded = true
      removeEntry(entry)
    }

    await Promise.allSettled(pending.map(item => item.request))
    const cancelEntries = [...new Set([
      ...entries,
      ...pending
        .filter(item => item.entry.started && !item.entry.failed)
        .map(item => item.entry)
    ])]
      .filter(entry => entry.batchId === batchId && entry.discarded)

    if (cancelRequest) {
      await Promise.all(cancelEntries.map(entry => cancelRequest(batchId, entry.feedSeq)))
    }
  }

  function onConfirmSucceeded (batchId, feedSeq) {
    const entry = getEntry(batchId, feedSeq)
    if (entry) removeEntry(entry)
    closeDialog()
  }

  function onConfirmFailed (batchId, feedSeq, abnormal = false) {
    const entry = getEntry(batchId, feedSeq)
    if (entry) removeEntry(entry)
    if (abnormal) closeDialog()
  }

  function dispose () {
    for (const entry of [...entriesByKey.values()]) {
      entry.cancelled = true
      removeEntry(entry)
    }
    closeDialog()
  }

  return {
    totalSeconds,
    version,
    sessions,
    dialog,
    isDialogOpen,
    countdownFor,
    getEntry,
    startWeigh,
    cancelSession,
    discardBatch,
    onConfirmSucceeded,
    onConfirmFailed,
    closeDialog,
    dispose
  }
}
