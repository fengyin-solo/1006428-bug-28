/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
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

// 整组交接入参：勾选的记录 id，加上整组统一的处理班次与记录时间。
export type BatchHandoverInput = {
  ids: number[]
  shift: string
  recordTime: string
}

// 单条回话：成了、没过、被跳过，各自带原因，不允许有记录无声消失。
export type BatchItemOutcome = {
  id: number
  code: string
  // success=已落库；failed=校验没过（如出水氨氮值缺失），仍留在待处理；skipped=不该动（已达标/已被先落库的批次认走）。
  status: 'success' | 'failed' | 'skipped'
  reason: string
}

// 整批回执：一次落表之后逐条回话，并附整批汇总，驱动看板异常统计。
export type BatchResult = {
  ok: boolean
  batchId: string
  shift: string
  recordTime: string
  total: number
  successCount: number
  failureCount: number
  skipCount: number
  items: BatchItemOutcome[]
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
