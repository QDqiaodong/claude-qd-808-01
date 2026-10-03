<template>
  <div ref="rootRef">
    <div class="section-head">
      <h2>03 投料</h2>
      <span>投料口大按钮阵列 · 按投料顺序称量 · 环形倒计时 · 误差超 ±2% 拦截并记录异常</span>
    </div>

    <div class="panel">
      <div class="panel-title">
        <span>批次与投料口</span>
        <div style="display:flex;gap:8px;align-items:center">
          <el-select v-model="batchId" size="small" style="width:280px" :disabled="batchSwitching || dialogBusy" @change="onBatchChange">
            <el-option v-for="b in batches" :key="b.id" :label="`${b.batchNo} · ${b.recipe.name}`" :value="b.id" />
          </el-select>
          <el-button size="small" :loading="batchLoading" @click="loadBatch(batchId)">刷新</el-button>
        </div>
      </div>

      <div v-if="batch" class="mini muted" style="margin-bottom:10px">
        批次 {{ batch.batchNo }} · 配方 {{ batch.recipe.recipeCode }} · 计划产量 {{ batch.plannedTons }} 吨 ·
        状态 <span class="tag-chip chip-run">{{ statusName(batch.status) }}</span> ·
        已投 {{ doneCount }} / {{ batch.feedings.length }} 道
        <span v-if="batchSwitching" class="tag-chip chip-down" style="margin-left:8px">正在取消原批次称量…</span>
      </div>

      <div class="port-grid" v-if="batch">
        <div
          v-for="item in batch.feedings"
          :key="item.id"
          class="port-btn"
          :class="portClass(item)"
          @click="startWeigh(item)"
        >
          <div class="seq">{{ item.portNo }}</div>
          <div class="mname">{{ item.material.name }}</div>
          <div class="plan">计划 {{ Number(item.plannedKg).toFixed(0) }} kg</div>
          <div class="plan" v-if="item.actualKg && (item.status === 'DONE' || item.status === 'ABNORMAL')">实投 {{ Number(item.actualKg).toFixed(0) }} kg</div>
          <div class="tag">
            <span :class="tagClass(item)">{{ feedStatusName(item) }}</span>
            <span v-if="item.deviationRate != null && item.status !== 'PENDING' && item.status !== 'WEIGHING'" class="mini mono"
                  :style="{ marginLeft: 6, color: Math.abs(item.deviationRate) > 2 ? '#c62828' : '#2e7d32' }">
              误差 {{ Number(item.deviationRate) > 0 ? '+' : '' }}{{ Number(item.deviationRate).toFixed(2) }}%
            </span>
          </div>
          <div v-if="item.abnormalNote && item.status === 'ABNORMAL'" class="mini" style="color:#c62828;margin-top:6px">
            {{ item.abnormalNote }}
          </div>

          <!-- 环形倒计时：键含批次 ID，防止不同批次同序投料口串显 -->
          <svg v-if="countdownFor(batchId, item.feedSeq)" class="ring" width="46" height="46" viewBox="0 0 46 46">
            <circle cx="23" cy="23" r="18" fill="none" stroke="#ffe0b2" stroke-width="4" />
            <circle cx="23" cy="23" r="18" fill="none" stroke="#ef6c00" stroke-width="4" stroke-linecap="round"
                    :stroke-dasharray="CIRC" :stroke-dashoffset="CIRC * (1 - countdownFor(batchId, item.feedSeq) / TOTAL)"
                    transform="rotate(-90 23 23)" />
            <text x="23" y="27" text-anchor="middle">{{ countdownFor(batchId, item.feedSeq) }}</text>
          </svg>
        </div>
      </div>

      <div class="mini muted" style="margin-top:12px">
        规则：必须按投料口顺序依次投料；单道实际称重与计划量偏差超过 ±2% 会被拦截并记为异常（按钮变红）。切换批次或离开投料区会取消当前未完成的称量。
      </div>
    </div>

    <el-dialog
      v-model="dialogVisible"
      :title="`实际称重 → 确认投料（${dialogBatchNo}）`"
      width="420px"
      :modal="false"
      :lock-scroll="true"
      :close-on-click-modal="false"
      :close-on-press-escape="!dialogBusy"
      :show-close="!dialogBusy"
      @close="onDialogClosed"
    >
      <div v-if="dialog.item">
        <div class="param-card">
          <span>{{ dialog.item.portNo }} · {{ dialog.item.material.name }}</span>
          <b>计划 {{ Number(dialog.item.plannedKg).toFixed(2) }} kg</b>
        </div>
        <div style="margin-top:14px">
          <div class="mini muted" style="margin-bottom:6px">实际称重（kg）</div>
          <el-input-number v-model="dialogActual" :min="0" :step="10" :precision="2" style="width:100%" />
        </div>
        <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
          <el-button size="small" @click="preset(0)">按计划量</el-button>
          <el-button size="small" @click="preset(1.2)">偏差 +1.2%</el-button>
          <el-button size="small" @click="preset(-1.5)">偏差 −1.5%</el-button>
          <el-button size="small" type="danger" plain @click="preset(3.2)">偏差 +3.2%（触发异常）</el-button>
        </div>
        <div class="mini" style="margin-top:10px">
          预计误差：
          <b :style="{ color: Math.abs(estDeviation) > 2 ? '#c62828' : '#2e7d32' }">
            {{ estDeviation > 0 ? '+' : '' }}{{ estDeviation.toFixed(2) }}%
          </b>
          <span v-if="Math.abs(estDeviation) > 2" style="color:#c62828"> · 超出 ±2%，提交后将被拦截</span>
        </div>
      </div>
      <template #footer>
        <el-button :disabled="dialogBusy" @click="cancelDialogWeigh">取消称量</el-button>
        <el-button type="primary" :loading="dialogBusy" @click="confirmFeed">确认投料</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { fetchBatches, fetchBatch, feeding } from '../api'
import { useFeedingSessions } from './feedingSessions'

const TOTAL = 5
const CIRC = 2 * Math.PI * 18

const batches = ref([])
const batch = ref(null)
const batchId = ref(null)
const batchLoading = ref(false)
const batchSwitching = ref(false)
const rootRef = ref(null)
let sectionObserver = null
let hasLeftFeedingOnce = false
let loadToken = 0
const dialogActual = ref(0)

const sessions = useFeedingSessions({
  totalSeconds: TOTAL,
  weighRequest: (id, feedSeq) => feeding(id, { action: 'WEIGH', feedSeq }),
  cancelRequest: (id, feedSeq) => feeding(id, { action: 'CANCEL', feedSeq })
})
const { dialog, countdownFor } = sessions

const dialogVisible = computed({
  get: () => dialog.visible,
  set: (visible) => { dialog.visible = visible }
})
const dialogBusy = computed(() => dialog.busy || false)
const dialogBatchNo = computed(() => batch.value?.id === dialog.batchId ? batch.value.batchNo : dialog.batchNo || '')

watch(() => dialog.visible, (visible) => {
  if (visible && dialog.item) dialogActual.value = Number(dialog.item.plannedKg)
})

const doneCount = computed(() =>
  (batch.value?.feedings || []).filter(f => f.status === 'DONE').length
)
const estDeviation = computed(() => {
  const item = dialog.item
  if (!item) return 0
  const planned = Number(item.plannedKg)
  if (!planned) return 0
  return ((Number(dialogActual.value) - planned) / planned) * 100
})

function statusName (s) {
  return { PLANNED: '待排产', FEEDING: '投料中', PELLETING: '制粒中', QC: '质检中', RECHECK: '复检中', DONE: '已完成' }[s] || s
}
function feedStatusName (item) {
  if (countdownFor(batchId.value, item.feedSeq)) return '称量中'
  return { PENDING: '待投', WEIGHING: '称量中', DONE: '已投', ABNORMAL: '异常' }[item.status] || item.status
}
function tagClass (item) {
  if (countdownFor(batchId.value, item.feedSeq)) return 'tag-chip chip-down'
  return {
    PENDING: 'tag-chip chip-gray',
    WEIGHING: 'tag-chip chip-down',
    DONE: 'tag-chip chip-pass',
    ABNORMAL: 'tag-chip chip-reject'
  }[item.status]
}
function portClass (item) {
  const cls = []
  if (countdownFor(batchId.value, item.feedSeq) || item.status === 'WEIGHING') cls.push('weighing')
  else if (item.status === 'DONE') cls.push('done')
  else if (item.status === 'ABNORMAL') cls.push('abnormal')
  if (!operable(item)) cls.push('disabled')
  return cls
}

/** 待投/异常可重新发起；WEIGHING 通常是上次请求后的遗留状态，也允许再次称量接管 */
function operable (item) {
  if (!batch.value || batchSwitching.value) return false
  if (countdownFor(batchId.value, item.feedSeq)) return false
  if (item.status === 'PENDING' || item.status === 'ABNORMAL' || item.status === 'WEIGHING') {
    if (item.status === 'ABNORMAL' || item.status === 'WEIGHING') return true
    const prev = batch.value.feedings.find(f => f.feedSeq === item.feedSeq - 1)
    return !prev || prev.status === 'DONE'
  }
  return false
}

function findItem (batchData, feedSeq) {
  return batchData?.feedings?.find(f => f.feedSeq === feedSeq) || null
}

function applyBatch (data) {
  batch.value = data
  if (dialog.visible && dialog.batchId === data.id) {
    const latest = findItem(data, dialog.feedSeq)
    if (latest) {
      dialog.item = latest
      dialog.itemId = latest.id
      dialog.batchNo = data.batchNo
    }
  }
}

async function loadBatch (id = batchId.value) {
  if (!id) return
  const token = ++loadToken
  batchLoading.value = true
  try {
    const data = await fetchBatch(id)
    if (token === loadToken) applyBatch(data)
  } finally {
    if (token === loadToken) batchLoading.value = false
  }
}

async function onBatchChange (nextId) {
  const previousId = batch.value?.id
  if (nextId === previousId) return
  batchSwitching.value = true
  const token = ++loadToken
  const previousBatch = batch.value
  batch.value = null
  try {
    const [nextBatch] = await Promise.all([
      fetchBatch(nextId),
      previousId != null
        ? sessions.discardBatch(previousId).catch(e => ElMessage.warning(e.message))
        : Promise.resolve()
    ])
    if (token === loadToken) applyBatch(nextBatch)
  } catch {
    if (token === loadToken) batch.value = previousBatch
  } finally {
    if (token === loadToken) batchSwitching.value = false
  }
}

async function startWeigh (item) {
  if (!operable(item)) {
    if (item.status === 'DONE') return
    ElMessage.warning('请按投料口顺序依次投料')
    return
  }
  const targetBatchId = batchId.value
  try {
    await sessions.startWeigh(targetBatchId, item, batch.value.batchNo)
    item.status = 'WEIGHING'
    if (!item.abnormalNote) item.abnormalNote = null
  } catch (e) {
    ElMessage.warning(e.message)
    await loadBatch(targetBatchId)
  }
}

function onDialogClosed () {
  const targetBatchId = dialog.batchId
  const feedSeq = dialog.feedSeq
  if (targetBatchId == null || feedSeq == null || dialog.closing || dialog.aborted) return
  // X/Esc/遮罩关闭后的回滚放到下一个微任务：程序化关闭时先由调用方设置 dialog.closing。
  Promise.resolve().then(() => {
    if (!dialog.visible && !dialog.closing && !dialog.aborted &&
        dialog.batchId === targetBatchId && dialog.feedSeq === feedSeq) {
      void cancelDialogWeigh()
    }
  })
}

async function cancelDialogWeigh () {
  const targetBatchId = dialog.batchId
  const feedSeq = dialog.feedSeq
  if (targetBatchId == null || feedSeq == null) {
    sessions.closeDialog()
    return
  }
  dialog.closing = true
  try {
    await sessions.cancelSession(targetBatchId, feedSeq)
    await loadBatch(targetBatchId)
  } catch (e) {
    ElMessage.warning(e.message)
    dialog.aborted = true
    sessions.closeDialog()
  } finally {
    dialog.closing = false
  }
}

function preset (rate) {
  const planned = Number(dialog.item.plannedKg)
  dialogActual.value = Number((planned * (1 + rate / 100)).toFixed(2))
}

async function confirmFeed () {
  const targetBatchId = dialog.batchId
  const item = dialog.item
  if (targetBatchId == null || !item) return
  dialog.busy = true
  try {
    await feeding(targetBatchId, {
      action: 'CONFIRM',
      feedSeq: item.feedSeq,
      actualKg: Number(dialogActual.value)
    })
    ElMessage.success(`${item.portNo} ${item.material.name} 投料完成`)
    sessions.onConfirmSucceeded(targetBatchId, item.feedSeq)
    await loadBatch(targetBatchId)
  } catch (e) {
    const abnormal = /异常|偏差|±2%/.test(e.message)
    sessions.onConfirmFailed(targetBatchId, item.feedSeq, abnormal)
    ElMessage.error(e.message)
    await loadBatch(targetBatchId)
  } finally {
    dialog.busy = false
  }
}

onMounted(async () => {
  batches.value = await fetchBatches().catch(() => [])
  const pending = batches.value.find(b => (b.feedings || []).some(f => f.status === 'PENDING'))
  const target = pending || batches.value[0]
  if (target) {
    batchId.value = target.id
    await loadBatch(target.id)
  }

  if ('IntersectionObserver' in window && rootRef.value) {
    sectionObserver = new IntersectionObserver((entries) => {
      const entry = entries[0]
      if (entry?.isIntersecting) {
        hasLeftFeedingOnce = true
        return
      }
      if (!hasLeftFeedingOnce || batchId.value == null) return
      hasLeftFeedingOnce = false
      void sessions.discardBatch(batchId.value)
    }, { threshold: 0 })
    sectionObserver.observe(rootRef.value)
  }
})

onBeforeUnmount(() => {
  sectionObserver?.disconnect()
  sessions.dispose()
})
</script>
