// 通过 vite 的 SSR 模块加载器直接执行 TS（含 @ 别名），无需额外安装测试框架。
import { createServer } from 'vite'

const server = await createServer({ server: { middlewareMode: true }, logLevel: 'silent' })
const mod = await server.ssrLoadModule('/scripts/verify-batch.ts')
await server.close()
void mod
