import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  BatchHandoverPatch,
  BatchReceipt,
  BatchReceiptItem,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 渗滤液班次交接：只有「待处理」的水量允许整组提交，已达标的一律不进批。
const LEACHATE_KEY = 'leachate'
const HANDOVER_FROM_STATUS = '待处理'
const HANDOVER_TO_STATUS = '处理中'

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === ''
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

// 详情按 id 现读同一份存储：列表页与详情页永远读到同一版数据，不存在新旧不一致。
export function getEntry(key: string, id: number): EntryRow | null {
  return listRows(key).find((row) => Number(row.id) === Number(id)) ?? null
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
  // 目标状态名本身就是异常语义（指标异常/数据异常/超标预警/故障等）的，同样计入异常统计。
  const abnormalStatus = /异常|超标|故障|返工|延期|未达标|遗留/.test(target)
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal:
      NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)) || abnormalStatus,
    version: Number(rows[index].version ?? 0) + 1,
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 渗滤液班次整组交接：一次事务把勾选的多条一起落表，再逐条回话。
//
// 关键约束（对应整批只落第一条的故障修复）：
// 1. 全部勾选记录先按最新存储逐条校验，通过的一次性写回，不存在「写了第一条就停」；
// 2. 出水氨氮值缺失的那条判失败，原样留在「待处理」并计入异常统计，绝不无声消失；
// 3. 已成功落库的记录不回滚——失败的不影响同批已通过的，整批不做撤销；
// 4. 已经达标（非「待处理」）的水量不动，直接跳过；
// 5. 按处理编号 + version 做乐观互斥：两批同时提交同一条时，只认先落库的那一版，
//    后到的批次收到 conflict 回执，不会覆盖。
export function batchHandover(
  ids: number[],
  patch: BatchHandoverPatch,
  expectedVersions: Record<number, number> = {},
): BatchReceipt {
  const uniqueIds = [...new Set(ids.map((id) => Number(id)))]
  if (uniqueIds.length === 0) {
    return {
      ok: false,
      message: '没有勾选任何渗滤液处理记录',
      committed: [],
      failed: [],
      skipped: [],
      items: [],
    }
  }
  if (isBlank(patch.处理班次) || isBlank(patch.记录时间)) {
    return {
      ok: false,
      message: '处理班次与记录时间必须整组设好后再提交',
      committed: [],
      failed: [],
      skipped: [],
      items: [],
    }
  }

  const rows = listRows(LEACHATE_KEY)
  const next = [...rows]
  const items: BatchReceiptItem[] = []

  // 逐条校验 + 同一次事务内完成全部更新，最后统一 saveRows，一次落表。
  for (const id of uniqueIds) {
    const index = next.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      items.push({
        id,
        code: `#${id}`,
        ok: false,
        status: '记录不存在',
        message: `编号为 ${id} 的渗滤液处理记录不存在`,
        reason: 'not-found',
      })
      continue
    }

    const current = next[index]
    const code = String(current['处理编号'] ?? `#${id}`)
    const status = String(current.status)

    // 乐观互斥先于状态判断：调用方拿的是旧版本，说明这条已被先落库的批次改过
    // （成功提交会推进版本），只认先落库的那一版，后到批次收到 conflict 回话。
    // 注意：因氨氮缺失被「退回待处理」的记录不推进版本——它没成，仍要允许重试。
    const expected = expectedVersions[id]
    if (expected !== undefined && Number(current.version ?? 0) !== Number(expected)) {
      items.push({
        id,
        code,
        ok: false,
        status,
        message: `${code} 已被先落库的批次处理，本批不覆盖，只认先落库的版本`,
        reason: 'conflict',
      })
      continue
    }

    // 已经达标的水量不许再整批动；处理中/异常态也不属于「待处理」批。
    if (status !== HANDOVER_FROM_STATUS) {
      items.push({
        id,
        code,
        ok: false,
        status,
        message: `${code} 当前为「${status}」，不是待处理水量，本批不动`,
        reason: 'not-pending',
      })
      continue
    }

    // 出水氨氮值：整组补录的值优先，否则看记录里原有的；仍为空就判这条失败。
    const ammonia = isBlank(patch.出水氨氮值) ? current['出水氨氮值'] : patch.出水氨氮值
    if (isBlank(ammonia)) {
      // 没成的留在待处理里，并打上异常标记驱动运营概览异常统计——不许无声消失。
      // 不推进 version：这条没有真正落库，其他批次按它仍是待处理、仍可重试。
      next[index] = { ...current, abnormal: true }
      items.push({
        id,
        code,
        ok: false,
        status: HANDOVER_FROM_STATUS,
        message: `${code} 栽在出水氨氮值缺失上，仍留在待处理，请补录后再交接`,
        reason: 'missing-ammonia',
      })
      continue
    }

    const updated: EntryRow = {
      ...current,
      处理班次: String(patch.处理班次).trim(),
      记录时间: String(patch.记录时间).trim(),
      status: HANDOVER_TO_STATUS,
      pending: true,
      // 氨氮缺失已在上面拦截；这里只有氨氮齐全的记录会落库，异常标记随提交清除。
      出水氨氮值: String(ammonia).trim(),
      abnormal: false,
      version: Number(current.version ?? 0) + 1,
    }
    if (!isBlank(patch.出水水量)) {
      updated['出水水量'] = String(patch.出水水量).trim()
    }
    if (!isBlank(patch.出水COD值)) {
      updated['出水COD值'] = String(patch.出水COD值).trim()
    }
    next[index] = updated
    items.push({
      id,
      code,
      ok: true,
      status: HANDOVER_TO_STATUS,
      message: `${code} 已随班次「${updated['处理班次']}」落库，当前状态「${HANDOVER_TO_STATUS}」`,
    })
  }

  // 一次落表：成功的与「标记异常但仍待处理」的失败记录一起持久化，
  // 先一步入库的条目已包含在 next 中，整批不撤销任何成功项。
  saveRows(LEACHATE_KEY, next)

  const committed = items.filter((item) => item.ok)
  const failed = items.filter((item) => !item.ok && item.reason === 'missing-ammonia')
  const skipped = items.filter((item) => !item.ok && item.reason !== 'missing-ammonia')
  const message =
    `整批交接完成：${committed.length} 条落库` +
    `${failed.length ? `，${failed.length} 条因出水氨氮值缺失退回待处理` : ''}` +
    `${skipped.length ? `，${skipped.length} 条跳过未动` : ''}`

  return { ok: failed.length === 0, message, committed, failed, skipped, items }
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
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
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
