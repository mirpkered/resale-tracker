import { readFile, writeFile, mkdir, copyFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { applyBatch, emptyDocument, restoreBackup, safeParseDocument, stableJson } from './data-contract.mjs'

const root = process.cwd()
const currentPath = join(root, 'current/resale-data.v2.json')
const auditPath = join(root, 'audit/events.ndjson')
const incoming = process.env.SOURCE_FILE
const operation = process.env.OPERATION ?? 'apply'
const now = new Date().toISOString()
const actor = process.env.GITHUB_ACTOR ?? 'github-user'

if (!incoming || !incoming.startsWith(`${operation === 'restore' ? 'backups/' : 'incoming/'}`) || incoming.includes('..')) throw new Error('SOURCE_FILE must name a file under incoming/ (apply) or backups/ (restore).')
let current
try { current = safeParseDocument(await readFile(currentPath, 'utf8')) } catch (error) {
  if (error?.code !== 'ENOENT') throw error
  current = emptyDocument(now)
}
const raw = await readFile(join(root, incoming), 'utf8')
let next, event
if (operation === 'apply') {
  const batch = JSON.parse(raw)
  const result = applyBatch(current, batch, { now, actor })
  next = result.document
  event = result.duplicate ? null : next.audit.at(-1)
} else if (operation === 'restore') {
  const backup = safeParseDocument(raw)
  next = restoreBackup(current, backup, { expectedRevision: Number(process.env.EXPECTED_REVISION), now, actor })
  event = next.audit.at(-1)
} else throw new Error('OPERATION must be apply or restore.')

if (!event) { console.log('Batch already applied with the same content; no write was made.'); process.exit(0) }
const priorRev = `r${current.revision}-${Date.now()}`
const backupPath = join(root, `backups/resale-data-${priorRev}.json`)
await mkdir(dirname(backupPath), { recursive: true })
await writeFile(currentPath + '.tmp', `${stableJson(next)}\n`, 'utf8')
await writeFile(auditPath + '.tmp', `${await readFile(auditPath, 'utf8').catch(() => '')}${JSON.stringify(event)}\n`, 'utf8')
if (await readFile(currentPath, 'utf8').then(() => true).catch(() => false)) await copyFile(currentPath, backupPath)
else await writeFile(backupPath, `${stableJson(emptyDocument(now))}\n`, 'utf8')
await rename(currentPath + '.tmp', currentPath)
await rename(auditPath + '.tmp', auditPath)
execFileSync('git', ['add', currentPath, auditPath, backupPath])
execFileSync('git', ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'commit', '-m', `Apply resale data revision ${next.revision}`], { stdio: 'inherit' })
const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim()
if (!branch) throw new Error('Could not identify the workflow branch to push.')
execFileSync('git', ['push', 'origin', `HEAD:${branch}`], { stdio: 'inherit' })
console.log(`Pushed revision ${next.revision}; previous document backed up to ${backupPath.slice(root.length + 1)}.`)
