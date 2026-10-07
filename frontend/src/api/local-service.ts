import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, getMeta, listRows, resetRows, saveRows, setMeta } from '@/data/local-store'
import type {
  ActionResult,
  BatchHandoverInput,
  BatchItemOutcome,
  BatchResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

const LEACHATE_KEY = 'leachate'
// 渗滤液班次交接的处理编号台账：按处理编号记账，保证同一个编号只被认一次。
const HANDOVER_LEDGER_KEY = 'leachate:handover-ledger'

type LedgerEntry = {
  code: string
  batchId: string
  recordTime: string
}

type HandoverLedger = {
  batchSeq: number
  entries: LedgerEntry[]
}

function readLedger(): HandoverLedger {
  return getMeta<HandoverLedger>(HANDOVER_LEDGER_KEY, { batchSeq: 0, entries: [] })
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  // 末尾字段是模块自带的「…状态」文本列，和状态机保持同步，列表页与详情页才不会读到两套数。
  const statusTextField = meta.fields[meta.fields.length - 1]
  if (statusTextField in updated) {
    updated[statusTextField] = target
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

function isBlank(value: unknown): boolean {
  return String(value ?? '').trim() === ''
}

// 渗滤液班次整组交接：多选之后一次落表，落完逐条回话。
// 关键点都在这里：
// 1) 基于同一份快照逐条判定，所有结果（成功改、失败标记）合并成一个 next，整组只 saveRows 一次，杜绝「只写了打头那条」；
// 2) 单条失败（出水氨氮值缺失等）只标记该条 abnormal，它仍留在待处理里，不会无声消失，也不回退已先落库的其它条；
// 3) 已达标/处理中（非待处理）的水量一律 skipped，不允许整批再动；
// 4) 处理编号台账按编号幂等，两批同时提交同一条时只认先落库的那一版，后到的跳过且不重复计异常。
export function batchHandoverLeachate(input: BatchHandoverInput): BatchResult {
  const shift = input.shift.trim()
  const recordTime = input.recordTime.trim()
  if (!shift || !recordTime) {
    return {
      ok: false,
      batchId: '',
      shift,
      recordTime,
      total: 0,
      successCount: 0,
      failureCount: 0,
      skipCount: 0,
      items: [],
      message: '处理班次与记录时间必须整组设好后再交接',
    }
  }

  // 整批只取一份数据快照，整批只落这一份，保证组内判定口径一致。
  const rows = listRows(LEACHATE_KEY)
  const ledger = readLedger()
  const claimed = new Map(ledger.entries.map((entry) => [entry.code, entry]))
  const next = [...rows]
  const items: BatchItemOutcome[] = []
  // 同一批里重复勾选同一个 id 时也只认第一下。
  const seenIds = new Set<number>()

  for (const id of input.ids) {
    if (seenIds.has(id)) {
      continue
    }
    seenIds.add(id)
    const index = next.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      items.push({ id, code: `#${id}`, status: 'skipped', reason: '记录已不存在，整批未对其落库' })
      continue
    }
    const row = next[index]
    const code = isBlank(row['处理编号']) ? `#${id}` : String(row['处理编号'])
    const status = String(row.status)

    // 已达标、处理中、指标异常等非待处理记录：整批不许再动，只跳过，绝不覆盖。
    if (status !== '待处理') {
      items.push({
        id,
        code,
        status: 'skipped',
        reason: status === '已达标' ? '已达标的水量不允许整批再动' : `当前为「${status}」，不在待处理范围内`,
      })
      continue
    }

    // 处理编号已经被先落库的批次认走：只认第一版，这一版跳过，不重复计异常。
    const winner = claimed.get(code)
    if (winner) {
      items.push({
        id,
        code,
        status: 'skipped',
        reason: `处理编号已由批次 ${winner.batchId} 先落库，只认先落库的那一版`,
      })
      continue
    }

    // 校验没过（当前规则：出水氨氮值缺失）：该条留在待处理，并挂上异常标记供运营概览统计；不影响组内其它条。
    if (isBlank(row['出水氨氮值'])) {
      next[index] = { ...row, abnormal: true }
      items.push({
        id,
        code,
        status: 'failed',
        reason: '出水氨氮值缺失，未交接，仍留在待处理',
      })
      continue
    }

    const updated: EntryRow = {
      ...row,
      status: '处理中',
      pending: true,
      '处理班次': shift,
      '记录时间': recordTime,
      '处理状态': '处理中',
    }
    next[index] = updated
    claimed.set(code, { code, batchId: '', recordTime })
    items.push({ id, code, status: 'success', reason: '已按整组班次交接落库' })
  }

  const successItems = items.filter((item) => item.status === 'success')
  const failureCount = items.filter((item) => item.status === 'failed').length
  const skipCount = items.filter((item) => item.status === 'skipped').length

  // 没有任何一条可交接时不动表、不开批次号。
  if (successItems.length === 0) {
    // 失败条目的 abnormal 标记仍需一次性落表（它们留在待处理，但要在异常统计里露面）。
    if (failureCount > 0) {
      saveRows(LEACHATE_KEY, next)
    }
    return {
      ok: false,
      batchId: '',
      shift,
      recordTime,
      total: items.length,
      successCount: 0,
      failureCount,
      skipCount,
      items,
      message: '本批没有可落库的记录，已逐条标注原因；未通过的记录仍在待处理中',
    }
  }

  const batchId = `HB-${new Date().getFullYear()}-${String(ledger.batchSeq + 1).padStart(4, '0')}`
  for (const item of successItems) {
    const entry = claimed.get(item.code)
    if (entry) {
      entry.batchId = batchId
    }
  }

  // 整组一次落表：成功的、失败挂异常的，连同未动的行整体写入；不再逐条 save。
  saveRows(LEACHATE_KEY, next)
  setMeta(HANDOVER_LEDGER_KEY, {
    batchSeq: ledger.batchSeq + 1,
    entries: [...claimed.values()],
  })

  return {
    ok: true,
    batchId,
    shift,
    recordTime,
    total: items.length,
    successCount: successItems.length,
    failureCount,
    skipCount,
    items,
    message: `批次 ${batchId} 交接完成：${successItems.length} 条已落库${failureCount ? `，${failureCount} 条未通过仍在待处理` : ''}${skipCount ? `，${skipCount} 条跳过未动` : ''}`,
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    let abnormalCount: number
    if (meta.key === LEACHATE_KEY) {
      // 整批回执驱动异常统计：失败条目挂 abnormal，由概览按处理编号去重计数——同一编号只算一次。
      const abnormalCodes = new Set<string>()
      for (const row of entries) {
        if (row.abnormal) {
          abnormalCodes.add(isBlank(row['处理编号']) ? `#${row.id}` : String(row['处理编号']))
        }
      }
      abnormalCount = abnormalCodes.size
    } else {
      abnormalCount = entries.filter((row) => row.abnormal).length
    }
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: abnormalCount,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
