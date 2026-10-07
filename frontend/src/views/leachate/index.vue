<template>
  <section class="page" data-module="leachate">
    <header class="page-head">
      <div>
        <h2>渗滤液处理管理</h2>
        <p class="page-desc">维护渗滤液处理记录，围绕处理编号、进水水量、出水水量、出水COD值做登记、筛选与状态流转。待处理记录可多选后整组交接班次。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记渗滤液处理记录</button>
        <button class="btn" type="button" @click="exportRows">导出渗滤液处理清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <!-- 整组班次交接：勾选待处理记录、整组设好班次与记录时间，一次落表、逐条回话。 -->
    <section class="batch-bar">
      <div class="batch-title">
        班次整组交接
        <span class="batch-hint">已选 {{ selectedIds.size }} 条待处理记录（已达标/处理中的记录不可勾选，整批不会动它们）</span>
      </div>
      <div class="batch-fields">
        <label class="filter-item">
          <span>处理班次</span>
          <select v-model="batchShift">
            <option value="" disabled>请选择班次</option>
            <option v-for="item in shiftOptions" :key="item" :value="item">{{ item }}</option>
          </select>
        </label>
        <label class="filter-item">
          <span>记录时间</span>
          <input v-model="batchRecordTime" type="datetime-local" />
        </label>
        <button
          class="btn primary"
          type="button"
          :disabled="selectedIds.size === 0"
          @click="submitBatch"
        >
          整组交接（{{ selectedIds.size }}）
        </button>
        <button class="btn ghost" type="button" :disabled="selectedIds.size === 0" @click="clearSelection">
          清空选择
        </button>
      </div>
    </section>

    <!-- 整批回执：哪几条成了、哪条栽在出水氨氮值缺失上，一条条写清楚。 -->
    <section v-if="batchResult" class="receipt" :class="{ 'receipt-error': !batchResult.ok }">
      <header class="receipt-head">
        <strong>整批回执{{ batchResult.batchId ? ` · 批次 ${batchResult.batchId}` : '' }}</strong>
        <span>{{ batchResult.message }}</span>
        <button class="link" type="button" @click="batchResult = null">关闭回执</button>
      </header>
      <ul class="receipt-list">
        <li v-for="item in batchResult.items" :key="item.id" class="receipt-item">
          <span class="receipt-code">{{ item.code }}</span>
          <span class="receipt-tag" :class="`tag-${item.status}`">
            {{ item.status === 'success' ? '已落库' : item.status === 'failed' ? '未通过' : '已跳过' }}
          </span>
          <span class="receipt-reason">{{ item.reason }}</span>
        </li>
      </ul>
    </section>

    <table class="data-table">
      <thead>
        <tr>
          <th class="col-check">
            <input
              type="checkbox"
              :checked="allPendingSelected"
              :disabled="pendingRows.length === 0"
              @change="toggleAll"
            />
          </th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-selected': selectedIds.has(Number(row.id)) }">
          <td class="col-check">
            <input
              v-if="isPending(row)"
              type="checkbox"
              :checked="selectedIds.has(Number(row.id))"
              @change="toggleOne(Number(row.id))"
            />
            <span v-else class="check-locked" title="仅待处理记录可参与整组交接">—</span>
          </td>
          <td v-for="column in columns" :key="column">{{ row[column] === '' || row[column] == null ? '—' : row[column] }}</td>
          <td>
            {{ row.status }}
            <span v-if="row.abnormal" class="abnormal-flag" title="该记录存在异常，已计入运营概览异常统计">异常</span>
          </td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">详情</button>
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无渗滤液处理数据，可先登记渗滤液处理记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条渗滤液处理记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 详情：和列表同读一份本地数据，整组交接后这里看到的班次/时间与列表一致。 -->
    <div v-if="detailRow" class="modal-mask" @click.self="closeDetail">
      <div class="modal-card">
        <header class="modal-head">
          <strong>渗滤液处理记录详情 · {{ detailRow['处理编号'] }}</strong>
          <button class="link" type="button" @click="closeDetail">关闭</button>
        </header>
        <dl class="detail-grid">
          <div v-for="column in detailColumns" :key="column" class="detail-item">
            <dt>{{ column }}</dt>
            <dd>{{ detailRow[column] === '' || detailRow[column] == null ? '—' : detailRow[column] }}</dd>
          </div>
          <div class="detail-item">
            <dt>当前状态</dt>
            <dd>{{ detailRow.status }}{{ detailRow.abnormal ? '（异常）' : '' }}</dd>
          </div>
        </dl>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  batchHandoverLeachate,
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { BatchResult, EntryRow } from '@/data/types'

const meta = moduleMeta('leachate')
const columns = ['处理编号', '进水水量', '出水水量', '出水COD值', '出水氨氮值', '处理班次', '记录时间', '处理状态']
const detailColumns = columns
const actions = ['提交处理', '确认达标', '上报异常']
const statuses = ['待处理', '处理中', '已达标', '指标异常']
const shiftOptions = ['白班', '中班', '夜班']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

// 多选：只有待处理记录能进整组交接。
const selectedIds = ref<Set<number>>(new Set())
const batchShift = ref('')
const batchRecordTime = ref('')
const batchResult = ref<BatchResult | null>(null)
const detailId = ref<number | null>(null)

function isPending(row: EntryRow): boolean {
  return String(row.status) === '待处理'
}

function toVolume(value: unknown): number {
  const n = Number.parseFloat(String(value ?? ''))
  return Number.isFinite(n) ? n : 0
}

const pendingRows = computed(() => rows.value.filter(isPending))
const allPendingSelected = computed(
  () => pendingRows.value.length > 0 && pendingRows.value.every((row) => selectedIds.value.has(Number(row.id))),
)

// 待处理水量 / 处理中水量按进水水量汇总，未通过的记录仍留在待处理，水量不会凭空少掉。
const stats = computed(() => {
  const pendingWater = pendingRows.value.reduce((sum, row) => sum + toVolume(row['进水水量']), 0)
  const processingWater = rows.value
    .filter((row) => String(row.status) === '处理中')
    .reduce((sum, row) => sum + toVolume(row['进水水量']), 0)
  const abnormalCodes = new Set(
    rows.value.filter((row) => row.abnormal).map((row) => String(row['处理编号'] ?? row.id)),
  )
  return [
    { label: '待处理水量（m³）', value: pendingWater.toFixed(1) },
    { label: '处理中水量（m³）', value: processingWater.toFixed(1) },
    { label: '指标异常次数', value: abnormalCodes.size },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const detailRow = computed(() =>
  detailId.value === null ? null : rows.value.find((row) => Number(row.id) === detailId.value) ?? null,
)

function toggleOne(id: number) {
  const next = new Set(selectedIds.value)
  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
  }
  selectedIds.value = next
}

function toggleAll(event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  selectedIds.value = checked ? new Set(pendingRows.value.map((row) => Number(row.id))) : new Set()
}

function clearSelection() {
  selectedIds.value = new Set()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '渗滤液处理记录登记入口尚未接入审批流'
}

// 整组交接：一次提交、一次落表；回执逐条展示，失败的留在待处理并保留勾选方便补录后重试。
function submitBatch() {
  errorMessage.value = ''
  if (selectedIds.value.size === 0) {
    return
  }
  if (!batchShift.value.trim() || !batchRecordTime.value.trim()) {
    errorMessage.value = '请先整组选择处理班次并设置记录时间'
    return
  }
  const result = batchHandoverLeachate({
    ids: [...selectedIds.value],
    shift: batchShift.value,
    recordTime: batchRecordTime.value.replace('T', ' '),
  })
  batchResult.value = result
  if (!result.ok && result.successCount === 0) {
    errorMessage.value = result.message
  }
  reload()
  // 已落库的不再勾选；仍待处理（未通过）的保留勾选，补录出水氨氮值后可再次交接。
  const stillPending = new Set(pendingRows.value.map((row) => Number(row.id)))
  selectedIds.value = new Set([...selectedIds.value].filter((id) => stillPending.has(id)))
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function openDetail(row: EntryRow) {
  detailId.value = Number(row.id)
}

function closeDetail() {
  detailId.value = null
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    // 清掉已经不在待处理范围内的勾选项。
    const pendingIds = new Set(rows.value.filter(isPending).map((row) => Number(row.id)))
    selectedIds.value = new Set([...selectedIds.value].filter((id) => pendingIds.has(id)))
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '渗滤液处理列表读取失败'
  }
}

function nowLocal(): string {
  const d = new Date()
  d.setSeconds(0, 0)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

onMounted(() => {
  batchRecordTime.value = nowLocal()
  reload()
})
</script>
