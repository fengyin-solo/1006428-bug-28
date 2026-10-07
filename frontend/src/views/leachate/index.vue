<template>
  <section class="page" data-module="leachate">
    <header class="page-head">
      <div>
        <h2>渗滤液处理管理</h2>
        <p class="page-desc">维护渗滤液处理记录，围绕处理编号、进水水量、出水水量、出水COD值做登记、筛选与状态流转。班次交接支持多选整组提交，逐条回话。</p>
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

    <!-- 整组交接面板：勾选待处理记录后出现，处理班次与记录时间整组设好一次落表 -->
    <div v-if="batchIds.length" class="batch-bar">
      <div class="batch-head">
        <strong>班次交接 · 整组处理</strong>
        <span>已勾选 {{ batchIds.length }} 条待处理记录，已达标的水量不在批内</span>
      </div>
      <div class="batch-form">
        <label class="filter-item">
          <span>处理班次（整组）</span>
          <input v-model="batchPatch.处理班次" placeholder="如：白班 / 夜班" />
        </label>
        <label class="filter-item">
          <span>记录时间（整组）</span>
          <input v-model="batchPatch.记录时间" placeholder="如：2026-10-07 08:00" />
        </label>
        <label class="filter-item">
          <span>出水水量（整组补录，可留空）</span>
          <input v-model="batchPatch.出水水量" placeholder="留空则保留各条原值" />
        </label>
        <label class="filter-item">
          <span>出水COD值（整组补录，可留空）</span>
          <input v-model="batchPatch.出水COD值" placeholder="留空则保留各条原值" />
        </label>
        <label class="filter-item">
          <span>出水氨氮值（整组补录，可留空）</span>
          <input v-model="batchPatch.出水氨氮值" placeholder="留空则按各条原值，缺失的会被退回" />
        </label>
        <button class="btn primary" type="button" :disabled="submitting" @click="submitBatch">
          {{ submitting ? '正在整批落表…' : '整批提交交接' }}
        </button>
        <button class="btn ghost" type="button" :disabled="submitting" @click="clearSelection">取消勾选</button>
      </div>
      <p v-if="batchError" class="error-text">{{ batchError }}</p>
    </div>

    <!-- 整批回执：哪几条成了、哪条栽在出水氨氮值缺失上，一条条列清楚 -->
    <div v-if="receipt" class="receipt" :class="{ 'has-fail': receipt.failed.length || receipt.skipped.length }">
      <div class="receipt-head">
        <strong>整批回执</strong>
        <span>{{ receipt.message }}</span>
        <button class="link" type="button" @click="receipt = null">收起</button>
      </div>
      <ul class="receipt-list">
        <li v-for="item in receipt.items" :key="item.id" class="receipt-item" :class="receiptClass(item)">
          <span class="receipt-flag">{{ receiptFlag(item) }}</span>
          <span class="receipt-code">{{ item.code }}</span>
          <span class="receipt-msg">{{ item.message }}</span>
        </li>
      </ul>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th class="col-check">
            <input
              type="checkbox"
              :checked="allPendingChecked"
              :indeterminate="somePendingChecked"
              :disabled="!pendingRows.length"
              @change="toggleAll"
            />
          </th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-abnormal': row.abnormal }">
          <td class="col-check">
            <input
              type="checkbox"
              :checked="isSelected(row)"
              :disabled="String(row.status) !== '待处理'"
              :title="String(row.status) === '待处理' ? '' : '只有待处理记录才能进入班次交接批'"
              @change="toggleOne(row)"
            />
          </td>
          <td v-for="column in columns" :key="column">{{ row[column] === '' ? '—' : (row[column] ?? '—') }}</td>
          <td>
            {{ row.status }}
            <span v-if="row.abnormal" class="abnormal-tag">异常</span>
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

    <!-- 详情抽屉：每次点开都从同一份数据存储现读，列表页与详情页读到的数保持一致 -->
    <div v-if="detailRow" class="drawer-mask" @click.self="closeDetail">
      <aside class="drawer">
        <header class="drawer-head">
          <strong>渗滤液处理记录详情 · {{ detailRow['处理编号'] }}</strong>
          <button class="link" type="button" @click="closeDetail">关闭</button>
        </header>
        <dl class="detail-list">
          <div v-for="column in columns" :key="column" class="detail-item">
            <dt>{{ column }}</dt>
            <dd>{{ detailRow[column] === '' ? '（未填写）' : (detailRow[column] ?? '—') }}</dd>
          </div>
          <div class="detail-item">
            <dt>当前状态</dt>
            <dd>{{ detailRow.status }}<span v-if="detailRow.abnormal" class="abnormal-tag">异常</span></dd>
          </div>
        </dl>
      </aside>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条渗滤液处理记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  batchHandover,
  downloadEntries,
  getEntry,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { BatchReceipt, BatchReceiptItem, EntryRow } from '@/data/types'

const meta = moduleMeta('leachate')
const columns = ["处理编号", "进水水量", "出水水量", "出水COD值", "出水氨氮值", "处理班次", "记录时间", "处理状态"]
const actions = ["提交处理", "确认达标", "上报异常"]
const statuses = ["待处理", "处理中", "已达标", "指标异常"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

// 整组交接的勾选与整组写入值
const selected = ref<Map<number, number>>(new Map())
const submitting = ref(false)
const batchError = ref('')
const batchPatch = reactive({
  处理班次: '',
  记录时间: '',
  出水水量: '',
  出水COD值: '',
  出水氨氮值: '',
})
const receipt = ref<BatchReceipt | null>(null)
const detailRow = ref<EntryRow | null>(null)

function toAmount(value: string | number | boolean | undefined): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0
  }
  const parsed = Number.parseFloat(String(value ?? '').trim())
  return Number.isFinite(parsed) ? parsed : 0
}

// 待处理/处理中按进水水量汇总，异常按条数统计，落库后这里跟着存储实时变
const stats = computed(() => {
  const pendingWater = rows.value
    .filter((row) => String(row.status) === '待处理')
    .reduce((sum, row) => sum + toAmount(row['进水水量']), 0)
  const processingWater = rows.value
    .filter((row) => String(row.status) === '处理中')
    .reduce((sum, row) => sum + toAmount(row['进水水量']), 0)
  const abnormalCount = rows.value.filter((row) => row.abnormal).length
  return [
    { label: '待处理水量（吨）', value: pendingWater.toFixed(1) },
    { label: '处理中水量（吨）', value: processingWater.toFixed(1) },
    { label: '指标异常次数', value: abnormalCount },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const batchIds = computed(() => [...selected.value.keys()])
const pendingRows = computed(() => rows.value.filter((row) => String(row.status) === '待处理'))
const allPendingChecked = computed(
  () => pendingRows.value.length > 0 && pendingRows.value.every((row) => selected.value.has(Number(row.id))),
)
const somePendingChecked = computed(
  () => !allPendingChecked.value && pendingRows.value.some((row) => selected.value.has(Number(row.id))),
)

function isSelected(row: EntryRow): boolean {
  return selected.value.has(Number(row.id))
}

function toggleOne(row: EntryRow) {
  const id = Number(row.id)
  const next = new Map(selected.value)
  if (next.has(id)) {
    next.delete(id)
  } else if (String(row.status) === '待处理') {
    // 记录勾选时的版本号：两批同提一条时，后到的批次据此识别已被先落库的版本
    next.set(id, Number(row.version ?? 0))
  }
  selected.value = next
}

function toggleAll(event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  const next = new Map(selected.value)
  for (const row of pendingRows.value) {
    const id = Number(row.id)
    if (checked) {
      next.set(id, Number(row.version ?? 0))
    } else {
      next.delete(id)
    }
  }
  selected.value = next
}

function clearSelection() {
  selected.value = new Map()
  batchError.value = ''
  batchPatch.处理班次 = ''
  batchPatch.记录时间 = ''
  batchPatch.出水水量 = ''
  batchPatch.出水COD值 = ''
  batchPatch.出水氨氮值 = ''
}

function submitBatch() {
  batchError.value = ''
  const ids = batchIds.value
  if (!ids.length) {
    batchError.value = '请先勾选至少一条待处理的渗滤液记录'
    return
  }
  if (!batchPatch.处理班次.trim() || !batchPatch.记录时间.trim()) {
    batchError.value = '处理班次与记录时间必须整组设好后再提交'
    return
  }
  submitting.value = true
  try {
    // 一次落表，服务层逐条校验后返回逐条回执
    const result = batchHandover(
      ids,
      {
        处理班次: batchPatch.处理班次,
        记录时间: batchPatch.记录时间,
        出水水量: batchPatch.出水水量,
        出水COD值: batchPatch.出水COD值,
        出水氨氮值: batchPatch.出水氨氮值,
      },
      Object.fromEntries(selected.value),
    )
    receipt.value = result
    // 成了的移出勾选；没成的（氨氮缺失等）保留勾选，补录后可直接再交，绝不无声消失
    const remain = new Map(selected.value)
    for (const item of result.committed) {
      remain.delete(item.id)
    }
    selected.value = remain
    reload()
  } catch (error) {
    batchError.value = error instanceof Error ? error.message : '整批交接落表失败'
  } finally {
    submitting.value = false
  }
}

function receiptClass(item: BatchReceiptItem): string {
  if (item.ok) {
    return 'is-ok'
  }
  return item.reason === 'missing-ammonia' ? 'is-fail' : 'is-skip'
}

function receiptFlag(item: BatchReceiptItem): string {
  if (item.ok) {
    return '已落库'
  }
  if (item.reason === 'missing-ammonia') {
    return '已退回'
  }
  if (item.reason === 'conflict') {
    return '已被先处理'
  }
  return '跳过'
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
  // 现读存储：整批落库后详情点开一定是最新班次/出水值，不会再读到旧数
  const fresh = getEntry(meta.key, Number(row.id))
  detailRow.value = fresh ?? row
}

function closeDetail() {
  detailRow.value = null
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    // 清掉已不在待处理集合里的勾选（已被其他批次落库的不会残留在选择中）
    const liveIds = new Set(
      rows.value.filter((row) => String(row.status) === '待处理').map((row) => Number(row.id)),
    )
    const remain = new Map(
      [...selected.value].filter(([id]) => liveIds.has(id)),
    )
    if (remain.size !== selected.value.size) {
      selected.value = remain
    }
    if (detailRow.value) {
      detailRow.value = getEntry(meta.key, Number(detailRow.value.id))
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '渗滤液处理列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.batch-bar {
  background: #fff;
  border: 1px solid var(--brand);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 12px;
}
.batch-head {
  display: flex;
  gap: 12px;
  align-items: baseline;
  margin-bottom: 8px;
  font-size: 13px;
}
.batch-head span {
  color: var(--muted);
  font-size: 12px;
}
.batch-form {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: flex-end;
}
.col-check {
  width: 36px;
  text-align: center;
}
.row-abnormal {
  background: #fef3f2;
}
.abnormal-tag {
  display: inline-block;
  margin-left: 6px;
  background: #b42318;
  color: #fff;
  border-radius: 999px;
  padding: 0 8px;
  font-size: 11px;
}
.receipt {
  background: #f0f9f1;
  border: 1px solid #abdfc1;
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
}
.receipt.has-fail {
  background: #fffbfa;
  border-color: #f0b8a4;
}
.receipt-head {
  display: flex;
  gap: 10px;
  align-items: baseline;
  font-size: 13px;
  margin-bottom: 6px;
}
.receipt-head span {
  color: var(--muted);
  font-size: 12px;
}
.receipt-head .link {
  margin-left: auto;
}
.receipt-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.receipt-item {
  font-size: 12px;
  display: flex;
  gap: 8px;
  align-items: baseline;
}
.receipt-flag {
  border-radius: 4px;
  padding: 0 6px;
  font-size: 11px;
  line-height: 18px;
}
.receipt-item.is-ok .receipt-flag {
  background: #d1fadf;
  color: #05603a;
}
.receipt-item.is-fail .receipt-flag {
  background: #fee4e2;
  color: #b42318;
}
.receipt-item.is-skip .receipt-flag {
  background: #eaecf0;
  color: #475467;
}
.receipt-code {
  font-weight: 600;
}
.receipt-msg {
  color: #344054;
}
.drawer-mask {
  position: fixed;
  inset: 0;
  background: rgba(16, 24, 40, 0.45);
  display: flex;
  justify-content: flex-end;
  z-index: 20;
}
.drawer {
  width: 420px;
  max-width: 90vw;
  background: #fff;
  height: 100%;
  padding: 16px;
  overflow-y: auto;
}
.drawer-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 12px;
}
.detail-list {
  margin: 0;
}
.detail-item {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px dashed var(--border);
  padding: 8px 0;
  font-size: 13px;
}
.detail-item dt {
  color: var(--muted);
}
.detail-item dd {
  margin: 0;
  text-align: right;
}
</style>
