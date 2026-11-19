import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { ScheduleSettings, readStoredPermissions, writePermissions } from '../config/permissions'
import { type Db, openDb } from '../db/client'
import { type ScheduledRun, lastRun, lastSuccessfulRun } from '../db/scheduled-runs'
import { hostById } from '../hosts'
import { NoHomeError, dbPath, discoverHome, permissionsPath, resolveWorkspace } from '../paths'
import {
  CRONTAB_LIST, type JobCommand, type JobKind, type JobPlan, type JobSpec, type PlatformState, SYSTEMD_PROBE, readCrontab,
  type SchedulePlatform, crontabLine, currentCrontabLine, installPlan, jobName, launchAgentPath, launchdPlist, nextRunAt,
  removePlans, schtasksQuery, systemdUnits, unitPaths, windowsScript, windowsScriptPath,
} from '../schedule/jobs'
import { schedulePrompt, scheduledRun } from '../schedule/run'
import { type EffectiveSchedule, effectiveSchedule } from '../schedule/settings'
import { type Exec, type HostRunner, type ScheduleFs, spawnHost, systemExec, systemFs } from '../schedule/system'

export interface ScheduleOptions {
  workspace?: string
  home?: string
  dryRun?: boolean
  json?: boolean
  platform?: NodeJS.Platform
  userHome?: string
  uid?: number
  pathEnv?: string
  program?: string[]
  exec?: Exec
  fs?: ScheduleFs
  now?: () => Date
  out?: (line: string) => void
  err?: (line: string) => void
}

export interface InstallOptions extends ScheduleOptions {
  time?: string
  mode?: string
  host?: string
}

export interface RunOptions extends ScheduleOptions {
  runHost?: HostRunner
  timeoutMs?: number
  env?: Record<string, string | undefined>
}

/** The jobduck binary, or bun plus the entry script when running from source. */
export function jobduckProgram(execPath = process.execPath, script = process.argv[1]): string[] {
  const fromSource = script !== undefined && /\.(c|m)?[jt]s$/.test(script) && !script.includes('$bunfs') && !script.includes('~BUN')
  return fromSource ? [execPath, resolve(script)] : [execPath]
}

interface Context {
  home: string
  workspace: string
  userHome: string
  platform: SchedulePlatform
  exec: Exec
  fs: ScheduleFs
  spec: (time: string) => JobSpec
  out: (line: string) => void
  err: (line: string) => void
  now: () => Date
}

function context(options: ScheduleOptions): Context | string {
  const userHome = options.userHome ?? homedir()
  const workspace = resolveWorkspace(options.workspace ?? process.cwd(), userHome)
  const found = options.home ?? discoverHome(workspace, userHome)
  if (found === undefined) return new NoHomeError(workspace).message
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
    return `jobduck schedule supports macOS, Linux and Windows, not ${platform}`
  }
  const home = resolve(found)
  const program = options.program ?? jobduckProgram()
  return {
    home, workspace, userHome, platform,
    exec: options.exec ?? systemExec,
    fs: options.fs ?? systemFs,
    spec: (time) => ({
      home, workspace, time, program, userHome, pathEnv: options.pathEnv ?? process.env.PATH, uid: options.uid ?? process.getuid?.() ?? 0,
    }),
    out: options.out ?? ((line: string) => console.log(line)),
    err: options.err ?? ((line: string) => console.error(line)),
    now: options.now ?? (() => new Date()),
  }
}

function contextOrReport(options: ScheduleOptions): Context | null {
  const ctx = context(options)
  if (typeof ctx !== 'string') return ctx
  ;(options.err ?? ((line: string) => console.error(line)))(ctx)
  return null
}

/** The platform's scheduler state, or the error that must stop install and remove before anything is written. */
function platformState(ctx: Context): PlatformState | { error: string } {
  if (ctx.platform !== 'linux') return { platform: ctx.platform }
  const crontab = readCrontab(ctx.exec(CRONTAB_LIST))
  if (crontab.kind === 'error') return { error: `${crontab.message}; nothing was changed, so your crontab is untouched` }
  return {
    platform: 'linux',
    systemd: ctx.exec(SYSTEMD_PROBE).code === 0,
    crontab: crontab.kind === 'text' ? crontab.text : '',
    crontabAvailable: crontab.kind !== 'unavailable',
  }
}

const word = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg))
const commandLine = (command: JobCommand) => command.argv.map(word).join(' ')

function describe(plan: JobPlan, dryRun: boolean, out: (line: string) => void) {
  const verb = (doing: string, done: string) => (dryRun ? `Would ${doing}` : done)
  const run = (command: JobCommand) => {
    out(`${verb('run', 'Run')}: ${commandLine(command)}${command.allowFailure ? ' (a failure is ignored)' : ''}`)
    if (command.input !== undefined) out(command.input === '' ? '  with empty input' : `  with input:\n${command.input.trimEnd()}`)
  }
  for (const file of plan.write) {
    out(`${verb('write', 'Write')} ${file.path}:`)
    out(file.content.trimEnd())
  }
  plan.commands.forEach(run)
  for (const path of plan.remove) out(`${verb('remove', 'Remove')} ${path}`)
  plan.afterRemove?.forEach(run)
}

function execute(ctx: Context, plan: JobPlan): string | null {
  const step = (command: JobCommand) => {
    const result = ctx.exec(command.argv, command.input === undefined ? undefined : { input: command.input })
    if (result.code === 0 || command.allowFailure) return null
    return `${commandLine(command)} failed (exit ${result.code})${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`
  }
  const written: { path: string; before: string | null }[] = []
  for (const file of plan.write) {
    written.push({ path: file.path, before: ctx.fs.read(file.path) })
    ctx.fs.write(file.path, file.content)
  }
  for (const command of plan.commands) {
    const failed = step(command)
    if (failed) {
      for (const { path, before } of written.reverse()) {
        if (before === null) ctx.fs.remove(path)
        else ctx.fs.write(path, before)
      }
      return written.length > 0 ? `${failed}; the files it wrote were put back` : failed
    }
  }
  for (const path of plan.remove) ctx.fs.remove(path)
  for (const command of plan.afterRemove ?? []) {
    const failed = step(command)
    if (failed) return failed
  }
  return null
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const localStamp = (date: Date) => date.toLocaleString()

function summaryLine(schedule: EffectiveSchedule): string {
  const host = schedule.host_set ? schedule.host : `${schedule.host} (first registered host)`
  return `Schedule: daily at ${schedule.time} local time, mode ${schedule.mode}, host ${host}`
}

export async function runScheduleInstall(options: InstallOptions = {}): Promise<number> {
  const ctx = contextOrReport(options)
  if (ctx === null) return 1
  const path = permissionsPath(ctx.home)
  const stored = readStoredPermissions(path)
  const overrides = Object.fromEntries(Object.entries({ time: options.time, mode: options.mode, host: options.host })
    .filter(([, value]) => value !== undefined))
  const parsed = ScheduleSettings.safeParse({ ...stored.permissions.schedule, ...overrides })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    ctx.err(`invalid schedule setting ${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'invalid'}`)
    return 2
  }
  const schedule = effectiveSchedule(parsed.data, ctx.workspace, ctx.home, ctx.userHome)
  const { modules } = stored.permissions
  if (schedule.mode === 'find_only' && !modules.find) ctx.err('Note: the find module is off, so scheduled runs stop at its gate until you turn it on.')
  if (schedule.mode === 'apply' && !modules.apply) ctx.err('Note: the apply module is off, so scheduled runs stop at its gate until you turn it on.')

  const state = platformState(ctx)
  if ('error' in state) {
    ctx.err(state.error)
    return 1
  }
  let plan: JobPlan
  try {
    plan = installPlan(ctx.spec(schedule.time), state)
  } catch (error) {
    ctx.err(message(error))
    return 1
  }
  ctx.out(summaryLine(schedule))
  ctx.out(`Job: ${plan.kind} ${plan.name}`)
  describe(plan, options.dryRun ?? false, ctx.out)
  const change = `set [schedule] enabled = true, time = "${schedule.time}", mode = "${schedule.mode}", host = "${schedule.host}" in ${path}`
  if (options.dryRun) {
    ctx.out(`Would ${change}`)
    ctx.out('Dry run: nothing written or run.')
    return 0
  }
  try {
    const failed = execute(ctx, plan)
    if (failed) {
      ctx.err(failed)
      return 1
    }
    writePermissions({ ...stored.permissions, schedule: { ...parsed.data, enabled: true, host: schedule.host } }, stored.revision, path)
  } catch (error) {
    ctx.err(message(error))
    return 1
  }
  ctx.out(`Installed. Next run: ${localStamp(nextRunAt(schedule.time, ctx.now()))}. Logs go to ${resolve(ctx.home, 'logs')}.`)
  return 0
}

function installed(ctx: Context, state: PlatformState): { unitsPresent: boolean; present: boolean } {
  const spec = ctx.spec('00:00')
  if (ctx.platform === 'darwin') return { unitsPresent: false, present: ctx.fs.read(launchAgentPath(spec)) !== null }
  if (ctx.platform === 'win32') return { unitsPresent: false, present: ctx.exec(schtasksQuery(ctx.home)).code === 0 }
  const paths = unitPaths(spec)
  const unitsPresent = ctx.fs.read(paths.timer) !== null || ctx.fs.read(paths.service) !== null
  return { unitsPresent, present: unitsPresent || currentCrontabLine(state.crontab ?? '', ctx.home) !== undefined }
}

export async function runScheduleRemove(options: ScheduleOptions = {}): Promise<number> {
  const ctx = contextOrReport(options)
  if (ctx === null) return 1
  const path = permissionsPath(ctx.home)
  const stored = readStoredPermissions(path)
  const state = platformState(ctx)
  if ('error' in state) {
    ctx.err(state.error)
    return 1
  }
  const { present, unitsPresent } = installed(ctx, state)
  const plans = present ? removePlans(ctx.spec(stored.permissions.schedule.time), { ...state, unitsPresent }) : []
  if (plans.length === 0) ctx.out('No OS job is installed for this Job Duck home.')
  for (const plan of plans) {
    ctx.out(`Job: ${plan.kind} ${plan.name}`)
    describe(plan, options.dryRun ?? false, ctx.out)
  }
  const enabled = stored.permissions.schedule.enabled
  if (options.dryRun) {
    if (enabled) ctx.out(`Would set [schedule] enabled = false in ${path}`)
    ctx.out('Dry run: nothing written or run.')
    return 0
  }
  try {
    for (const plan of plans) {
      const failed = execute(ctx, plan)
      if (failed) {
        ctx.err(failed)
        return 1
      }
    }
    if (enabled) {
      writePermissions({ ...stored.permissions, schedule: { ...stored.permissions.schedule, enabled: false } }, stored.revision, path)
    }
  } catch (error) {
    ctx.err(message(error))
    return 1
  }
  ctx.out(plans.length > 0 ? 'Removed. Scheduled runs are off.' : 'Scheduled runs are off.')
  return 0
}

export interface ScheduleStatus {
  settings: EffectiveSchedule
  job: { kind: JobKind | null; name: string | null; installed: boolean; current: boolean | null; error?: string }
  next_run_at: string | null
  last_run: ScheduledRun | null
}

function jobState(ctx: Context, schedule: EffectiveSchedule): ScheduleStatus['job'] {
  const spec = ctx.spec(schedule.time)
  if (ctx.platform === 'darwin') {
    const plist = ctx.fs.read(launchAgentPath(spec))
    return { kind: 'launchd', name: jobName('launchd', ctx.home), installed: plist !== null, current: plist === null ? null : plist === launchdPlist(spec) }
  }
  if (ctx.platform === 'win32') {
    const present = ctx.exec(schtasksQuery(ctx.home)).code === 0
    const script = ctx.fs.read(windowsScriptPath(spec))
    return { kind: 'schtasks', name: jobName('schtasks', ctx.home), installed: present, current: present && script !== null ? script === windowsScript(spec) : null }
  }
  const paths = unitPaths(spec)
  const timer = ctx.fs.read(paths.timer)
  if (timer !== null) {
    const units = systemdUnits(spec)
    return { kind: 'systemd', name: jobName('systemd', ctx.home), installed: true, current: timer === units.timer && ctx.fs.read(paths.service) === units.service }
  }
  const crontab = readCrontab(ctx.exec(CRONTAB_LIST))
  if (crontab.kind === 'error') return { kind: null, name: null, installed: false, current: null, error: crontab.message }
  const line = crontab.kind === 'text' ? currentCrontabLine(crontab.text, ctx.home) : undefined
  if (line !== undefined) return { kind: 'crontab', name: jobName('crontab', ctx.home), installed: true, current: line === crontabLine(spec) }
  return { kind: null, name: null, installed: false, current: null }
}

function readRuns<T>(home: string, read: (db: Db) => T | undefined): T | null {
  if (!existsSync(dbPath(home))) return null
  const db = openDb(dbPath(home), { readonly: true })
  try {
    return read(db) ?? null
  } catch {
    return null
  } finally {
    db.close()
  }
}

const readLastRun = (home: string) => readRuns(home, lastRun)
const readLastSuccess = (home: string, before: string) => readRuns(home, (db) => lastSuccessfulRun(db, before)?.started_at)

function runLine(run: ScheduledRun): string {
  const started = localStamp(new Date(run.started_at))
  if (run.finished_at === null) return `Last run: #${run.id} started ${started}, still running (${run.mode}, ${run.host})`
  const counts = run.found === null ? '' : `: found ${run.found}, applied ${run.applied}, pending ${run.pending}`
  const exit = run.exit_code === null ? '' : `, exit ${run.exit_code}`
  return `Last run: #${run.id} started ${started} (${run.mode}, ${run.host}${exit})${counts}${run.error ? `; ${run.error}` : ''}`
}

export async function runScheduleStatus(options: ScheduleOptions = {}): Promise<number> {
  const ctx = contextOrReport(options)
  if (ctx === null) return 1
  const stored = readStoredPermissions(permissionsPath(ctx.home))
  const settings = effectiveSchedule(stored.permissions.schedule, ctx.workspace, ctx.home, ctx.userHome)
  const job = jobState(ctx, settings)
  const next = job.installed && settings.enabled ? nextRunAt(settings.time, ctx.now()) : null
  const status: ScheduleStatus = { settings, job, next_run_at: next?.toISOString() ?? null, last_run: readLastRun(ctx.home) }
  if (options.json) {
    ctx.out(JSON.stringify(status, null, 2))
    return 0
  }
  ctx.out(summaryLine(settings))
  ctx.out(`Enabled: ${settings.enabled ? 'yes' : 'no ([schedule] enabled = false pauses runs)'}`)
  if (job.error) ctx.out(`Job: unknown (${job.error})`)
  else ctx.out(job.installed ? `Job: ${job.kind} ${job.name} installed` : 'Job: not installed (jobduck schedule install adds it)')
  if (job.current === false) ctx.out('The installed job differs from [schedule]: run jobduck schedule install again to update it.')
  ctx.out(`Next run: ${next ? localStamp(next) : 'none'}`)
  ctx.out(status.last_run ? runLine(status.last_run) : 'Last run: none yet')
  return 0
}

export async function runScheduleRun(options: RunOptions = {}): Promise<number> {
  const ctx = contextOrReport(options)
  if (ctx === null) return 1
  try {
    if (options.dryRun) {
      const settings = effectiveSchedule(readStoredPermissions(permissionsPath(ctx.home)).permissions.schedule, ctx.workspace, ctx.home, ctx.userHome)
      const now = ctx.now()
      const last = readLastSuccess(ctx.home, now.toISOString())
      ctx.out(summaryLine(settings))
      ctx.out(`Would record a scheduled_runs row in ${dbPath(ctx.home)} and run in ${ctx.workspace} with JOBDUCK_HOME=${ctx.home}:`)
      ctx.out(hostById(settings.host).headless(schedulePrompt(settings.mode, last, now)).map(word).join(' '))
      ctx.out('Dry run: nothing written or run.')
      return 0
    }
    const outcome = await scheduledRun({
      home: ctx.home, workspace: ctx.workspace, userHome: ctx.userHome, runHost: options.runHost ?? spawnHost,
      timeoutMs: options.timeoutMs, now: options.now, env: options.env, out: ctx.out, err: ctx.err,
    })
    return outcome.exitCode
  } catch (error) {
    ctx.err(message(error))
    return 1
  }
}
