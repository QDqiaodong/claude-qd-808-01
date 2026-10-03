import assert from 'node:assert/strict'
import { test } from 'node:test'
import { useFeedingSessions } from './feedingSessions.js'

function item (id, feedSeq) {
  return { id, feedSeq, portNo: `${feedSeq}号口`, material: { name: `原料${id}` } }
}

function createClock () {
  const intervals = new Map()
  let nextId = 1
  return {
    intervals,
    setInterval (callback) {
      const id = nextId++
      intervals.set(id, callback)
      return id
    },
    clearInterval (id) {
      intervals.delete(id)
    },
    tick (id) {
      intervals.get(id)?.()
    },
    tickAll () {
      for (const callback of [...intervals.values()]) callback()
    },
    size () {
      return intervals.size
    }
  }
}

function deferred () {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}

async function flush () {
  await Promise.resolve()
  await Promise.resolve()
}

test('倒计时中快速切换批次会取消旧批次且新批次使用隔离明细', async () => {
  const clock = createClock()
  const weighCalls = []
  const cancelCalls = []
  const sessions = useFeedingSessions({
    totalSeconds: 3,
    setIntervalFn: clock.setInterval.bind(clock),
    clearIntervalFn: clock.clearInterval.bind(clock),
    weighRequest: async (batchId, feedSeq) => { weighCalls.push([batchId, feedSeq]) },
    cancelRequest: async (batchId, feedSeq) => { cancelCalls.push([batchId, feedSeq]) }
  })

  const a1 = item(101, 1)
  await sessions.startWeigh(1, a1)
  const timerA = [...clock.intervals.keys()][0]
  clock.tick(timerA)
  assert.equal(sessions.countdownFor(1, 1), 2)

  await sessions.discardBatch(1)
  assert.equal(sessions.countdownFor(1, 1), 0)
  assert.deepEqual(cancelCalls, [[1, 1]])
  assert.equal(clock.size(), 0)

  const b1 = item(201, 1)
  await sessions.startWeigh(2, b1)
  const timerB = [...clock.intervals.keys()][0]
  assert.equal(sessions.countdownFor(2, 1), 3)
  clock.tick(timerA) // 旧定时器即使被误触发，也不能重建 A 的倒计时或弹窗。
  clock.tick(timerB)
  assert.equal(sessions.countdownFor(1, 1), 0)
  assert.equal(sessions.countdownFor(2, 1), 2)
  assert.equal(sessions.dialog.visible, false)

  // 快速切回 A 后允许重新称量，新状态不会继承 B 或上一次 A 的剩余秒数。
  await sessions.discardBatch(2)
  assert.deepEqual(cancelCalls, [[1, 1], [2, 1]])
  const a1Restart = item(101, 1)
  await sessions.startWeigh(1, a1Restart)
  assert.equal(sessions.countdownFor(1, 1), 3)
  assert.equal(sessions.countdownFor(2, 1), 0)
})

test('弹窗打开后切换批次会关闭旧弹窗，倒计时结束只打开当前批次明细', async () => {
  const clock = createClock()
  const cancelCalls = []
  const sessions = useFeedingSessions({
    totalSeconds: 1,
    setIntervalFn: clock.setInterval.bind(clock),
    clearIntervalFn: clock.clearInterval.bind(clock),
    weighRequest: async () => {},
    cancelRequest: async (batchId, feedSeq) => { cancelCalls.push([batchId, feedSeq]) }
  })

  const a1 = item(101, 1)
  await sessions.startWeigh(1, a1)
  clock.tickAll()
  assert.equal(sessions.dialog.visible, true)
  assert.equal(sessions.dialog.batchId, 1)
  assert.equal(sessions.dialog.itemId, 101)

  await sessions.discardBatch(1)
  assert.equal(sessions.dialog.visible, false)
  assert.deepEqual(cancelCalls, [[1, 1]])
  assert.equal(clock.size(), 0)

  const b1 = item(201, 1)
  await sessions.startWeigh(2, b1)
  clock.tickAll()
  assert.equal(sessions.dialog.visible, true)
  assert.equal(sessions.dialog.batchId, 2)
  assert.equal(sessions.dialog.itemId, 201)
  assert.equal(sessions.dialog.item.material.name, '原料201')
})

test('离开投料区时清理当前批次计时，组件卸载也不会泄漏 interval', async () => {
  const clock = createClock()
  const cancelCalls = []
  const sessions = useFeedingSessions({
    totalSeconds: 4,
    setIntervalFn: clock.setInterval.bind(clock),
    clearIntervalFn: clock.clearInterval.bind(clock),
    weighRequest: async () => {},
    cancelRequest: async (batchId, feedSeq) => { cancelCalls.push([batchId, feedSeq]) }
  })

  await sessions.startWeigh(1, item(101, 1))
  assert.equal(clock.size(), 1)

  await sessions.discardBatch(1)
  assert.equal(clock.size(), 0)
  assert.deepEqual(cancelCalls, [[1, 1]])
  assert.equal(sessions.dialog.visible, false)

  await sessions.startWeigh(2, item(201, 1))
  sessions.dispose()
  assert.equal(clock.size(), 0)
  assert.equal(sessions.dialog.visible, false)
})

test('切换发生在开始称量请求未完成时，返回后不会再启动旧计时', async () => {
  const clock = createClock()
  const cancelCalls = []
  const pending = deferred()
  const sessions = useFeedingSessions({
    totalSeconds: 3,
    setIntervalFn: clock.setInterval.bind(clock),
    clearIntervalFn: clock.clearInterval.bind(clock),
    weighRequest: () => pending.promise,
    cancelRequest: async (batchId, feedSeq) => { cancelCalls.push([batchId, feedSeq]) }
  })

  const started = sessions.startWeigh(1, item(101, 1))
  const switching = sessions.discardBatch(1)
  pending.resolve()
  await Promise.all([started, switching])
  await flush()

  assert.equal(clock.size(), 0)
  assert.equal(sessions.countdownFor(1, 1), 0)
  assert.deepEqual(cancelCalls, [[1, 1]])
})
