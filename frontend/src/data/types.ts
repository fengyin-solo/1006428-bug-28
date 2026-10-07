/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  // 乐观锁版本号：整批提交时用来识别「已被先落库的批次改动过」的记录。
  version?: number
  [field: string]: string | number | boolean | undefined
}

// 整批交接时整组写入的字段：处理班次、记录时间整组一致，出水指标可整组补录。
export type BatchHandoverPatch = {
  处理班次: string
  记录时间: string
  出水水量?: string
  出水COD值?: string
  出水氨氮值?: string
}

// 整批回执的逐条结果：成与不成、栽在哪一项，都一条条写清楚。
export type BatchReceiptItem = {
  id: number
  code: string
  ok: boolean
  status: string
  message: string
  reason?: 'missing-ammonia' | 'not-pending' | 'conflict' | 'not-found'
}

export type BatchReceipt = {
  ok: boolean
  message: string
  committed: BatchReceiptItem[]
  failed: BatchReceiptItem[]
  skipped: BatchReceiptItem[]
  items: BatchReceiptItem[]
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
