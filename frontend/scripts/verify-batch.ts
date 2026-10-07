import { batchHandover, listEntries, getEntry, runAction, loadOverview } from './src/api/local-service'
import { resetRows } from './src/data/local-store'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name} ${extra}`)
  }
}

function leachateOverview() {
  return loadOverview().modules.find((m) => m.name === '渗滤液处理')!
}

// ---------- 场景 1：多选三条待处理，其中一条出水氨氮缺失 ----------
resetRows('leachate')
let before = listEntries('leachate').items
const pendingIds = before.filter((r) => String(r.status) === '待处理').map((r) => Number(r.id))
check('种子里有 3 条待处理', pendingIds.length === 3, String(pendingIds))
const initialPendingWater = before
  .filter((r) => String(r.status) === '待处理')
  .reduce((s, r) => s + Number(r['进水水量']), 0)
check('待处理水量初始为 351.0', initialPendingWater === 351.0, String(initialPendingWater))

const versions: Record<number, number> = {}
for (const r of before) if (String(r.status) === '待处理') versions[Number(r.id)] = Number(r.version ?? 0)

const receipt = batchHandover(
  pendingIds,
  { 处理班次: '白班', 记录时间: '2026-10-07 08:00' },
  versions,
)
console.log('回执:', receipt.message)
check('整批 ok=false（有一条氨氮缺失）', receipt.ok === false)
check('落库 2 条', receipt.committed.length === 2, String(receipt.committed.map((i) => i.code)))
check('退回 1 条', receipt.failed.length === 1)
check('失败原因是出水氨氮缺失', receipt.failed[0]?.reason === 'missing-ammonia')
check('失败的是 LEAC-0002', receipt.failed[0]?.code === 'LEAC-0002')
check('每条都有回话', receipt.items.length === 3)

const r1 = getEntry('leachate', 1)!
const r2 = getEntry('leachate', 2)!
const r3 = getEntry('leachate', 3)!
check('LEAC-0001 已落为处理中', String(r1.status) === '处理中')
check('LEAC-0001 班次整组写为白班', r1['处理班次'] === '白班')
check('LEAC-0001 记录时间整组写好', r1['记录时间'] === '2026-10-07 08:00')
check('LEAC-0001 版本号已递增', Number(r1.version) === 1)
check('LEAC-0002 仍是待处理（没成不许消失）', String(r2.status) === '待处理')
check('LEAC-0002 被标异常驱动概览', r2.abnormal === true)
check('LEAC-0002 班次没有被半写', r2['处理班次'] === '')
check('LEAC-0003 已落为处理中', String(r3.status) === '处理中')
check('LEAC-0003 班次整组写为白班', r3['处理班次'] === '白班')

// 待处理水量只应少 120.5 + 98.5 = 219（氨氮缺失那条 132 还在），列表与详情同源
const after = listEntries('leachate').items
const pendingWaterAfter = after
  .filter((r) => String(r.status) === '待处理')
  .reduce((s, r) => s + Number(r['进水水量']), 0)
check('待处理水量只剩 LEAC-0002 的 132.0', pendingWaterAfter === 132.0, String(pendingWaterAfter))
check('列表与详情读到同一条 LEAC-0002', getEntry('leachate', 2)?.['处理班次'] === r2['处理班次'])

const ov = leachateOverview()
check('概览异常量含退回的 1 条', ov.abnormal >= 1, String(ov.abnormal))
check('概览待处理含退回的 1 条', ov.pending === after.filter((r) => r.pending).length)

// ---------- 场景 2：先入库的不允许被整批撤掉：再交一次，前两条已处理中应跳过 ----------
const receipt2 = batchHandover(
  pendingIds,
  { 处理班次: '夜班', 记录时间: '2026-10-07 20:00' },
  versions, // 故意仍用旧版本号
)
check('第二批：0 条落库', receipt2.committed.length === 0)
check('第二批：退回条版本未推进，仍按氨氮缺失退回', receipt2.failed.length === 1)
check('第二批：2 条已落库的报 conflict', receipt2.skipped.length === 2 && receipt2.skipped.every((i) => i.reason === 'conflict'))
const r1b = getEntry('leachate', 1)!
check('先落库的白班不被第二批改成夜班', r1b['处理班次'] === '白班')
check('先落库的仍是处理中（未被撤掉）', String(r1b.status) === '处理中')
// 第二批里若不带版本号（另一个界面的勾选），已处理中的两条按「非待处理」跳过而非冲突
const receipt2b = batchHandover(
  pendingIds,
  { 处理班次: '夜班', 记录时间: '2026-10-07 20:00' },
)
check('无版本号第二批：2 条 not-pending 跳过', receipt2b.skipped.length === 2 && receipt2b.skipped.every((i) => i.reason === 'not-pending'))

// ---------- 场景 3：两批同提同一条，只认先落库版本（version 冲突） ----------
resetRows('leachate')
const v1 = Number(getEntry('leachate', 1)?.version ?? 0)
// 第一批先落库
batchHandover([1], { 处理班次: '白班', 记录时间: '2026-10-07 08:00' }, { 1: v1 })
// 第二批拿着旧版本号提交同一条
const stale = batchHandover([1], { 处理班次: '夜班', 记录时间: '2026-10-07 20:00' }, { 1: v1 })
check('冲突批 0 落库', stale.committed.length === 0)
check('冲突原因标记 conflict', stale.items[0]?.reason === 'conflict')
check('只认先落库的白班版本', getEntry('leachate', 1)?.['处理班次'] === '白班')

// ---------- 场景 4：同一个处理编号只算一次（重复 id 去重） ----------
resetRows('leachate')
const dup = batchHandover(
  [1, 1, 1],
  { 处理班次: '白班', 记录时间: '2026-10-07 08:00', 出水氨氮值: '5.0' },
)
check('同批重复 id 只处理一次', dup.items.length === 1 && dup.committed.length === 1)

// ---------- 场景 5：已达标的水量不许整批动 ----------
resetRows('leachate')
const qualified = listEntries('leachate').items.find((r) => String(r.status) === '已达标')!
const qv = Number(qualified.version ?? 0)
const q = batchHandover(
  [Number(qualified.id)],
  { 处理班次: '白班', 记录时间: '2026-10-07 08:00' },
  { [Number(qualified.id)]: qv },
)
check('已达标记录不进批', q.committed.length === 0 && q.skipped[0]?.reason === 'not-pending')
check('已达标记录原样未动', getEntry('leachate', Number(qualified.id))?.status === '已达标')

// ---------- 场景 6：整组补录氨氮后，缺失那条可成功，不再卡 ----------
resetRows('leachate')
const fix = batchHandover(
  [2],
  { 处理班次: '夜班', 记录时间: '2026-10-07 20:00', 出水氨氮值: '4.8', 出水COD值: '60' },
)
check('整组补录氨氮后 LEAC-0002 落库', fix.committed.length === 1)
const r2fixed = getEntry('leachate', 2)!
check('补录的氨氮/COD 都写上了', r2fixed['出水氨氮值'] === '4.8' && r2fixed['出水COD值'] === '60')
check('落库后异常标记清除', r2fixed.abnormal === false)

// ---------- 场景 7：整组字段没设齐不允许提交 ----------
resetRows('leachate')
const empty = batchHandover([1], { 处理班次: '', 记录时间: '' })
check('班次/时间为空直接拒绝且不写库', empty.ok === false && empty.committed.length === 0)
check('拒绝后记录仍待处理', getEntry('leachate', 1)?.status === '待处理')

// ---------- 场景 8：单行“上报异常”也驱动概览异常统计 ----------
resetRows('leachate')
runAction('leachate', 4, '上报异常')
const ov2 = leachateOverview()
check('上报异常计入概览异常量', ov2.abnormal >= 1)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
