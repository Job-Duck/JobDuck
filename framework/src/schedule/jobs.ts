import { createHash } from 'node:crypto'
import { posix, resolve, win32 } from 'node:path'

/**
 * Pure writers for the daily OS job behind `jobduck schedule`: each returns the files to write or delete and the
 * commands to run, and never touches the machine. `src/commands/schedule.ts` executes a plan through an injected
 * exec and file system.
 */

export type SchedulePlatform = 'darwin' | 'linux' | 'win32'
export type JobKind = 'launchd' | 'systemd' | 'crontab' | 'schtasks'

export interface JobSpec {
  /** Absolute path of the Job Duck home; the workspace is absolute too. */
  home: string
  workspace: string
  time: string
  /** The jobduck executable, plus the script when running from source (`bun src/cli.ts`). */
  program: string[]
  userHome: string
  /** PATH for the job, so the agent host's binary is found the same way as in the installing shell. */
  pathEnv?: string
  uid?: number
}

export interface JobFile {
  path: string
  content: string
}

export interface JobCommand {
  argv: string[]
  input?: string
  /** A failure is expected and ignored (unloading a job that is not loaded). */
  allowFailure?: boolean
}

export interface JobPlan {
  kind: JobKind
  name: string
  write: JobFile[]
  remove: string[]
  /** Run after `write`, before `remove`. */
  commands: JobCommand[]
  /** Run after `remove`. */
  afterRemove?: JobCommand[]
}

export const scheduleHash = (home: string) => createHash('sha256').update(resolve(home)).digest('hex').slice(0, 10)

export const jobName = (kind: JobKind, home: string) => {
  const hash = scheduleHash(home)
  if (kind === 'launchd') return `jobduck.schedule.${hash}`
  if (kind === 'schtasks') return `JobDuck-schedule-${hash}`
  return `jobduck-schedule-${hash}`
}

export function parseTime(time: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time)
  if (!match) throw new Error(`invalid [schedule] time "${time}": use HH:MM (24-hour, local time)`)
  return { hour: Number(match[1]), minute: Number(match[2]) }
}

/** The next local occurrence of `time` strictly after `now`. */
export function nextRunAt(time: string, now: Date): Date {
  const { hour, minute } = parseTime(time)
  const next = new Date(now)
  next.setHours(hour, minute, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next
}

const runArgs = (spec: JobSpec) => [...spec.program, 'schedule', 'run', '--workspace', spec.workspace]

// launchd (macOS)

const launchAgentPath = (spec: JobSpec) =>
  posix.join(spec.userHome, 'Library', 'LaunchAgents', `${jobName('launchd', spec.home)}.plist`)

const xml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function launchdPlist(spec: JobSpec): string {
  const { hour, minute } = parseTime(spec.time)
  const env = [['JOBDUCK_HOME', spec.home], ...(spec.pathEnv ? [['PATH', spec.pathEnv]] : [])]
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${xml(jobName('launchd', spec.home))}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...runArgs(spec).map((arg) => `    <string>${xml(arg)}</string>`),
    '  </array>',
    `  <key>WorkingDirectory</key><string>${xml(spec.workspace)}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...env.map(([key, value]) => `    <key>${key}</key><string>${xml(value!)}</string>`),
    '  </dict>',
    '  <key>StartCalendarInterval</key>',
    `  <dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>`,
    '  <key>RunAtLoad</key><false/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

const launchdDomain = (spec: JobSpec) => `gui/${spec.uid ?? 0}`

function launchdInstall(spec: JobSpec): JobPlan {
  const name = jobName('launchd', spec.home)
  const path = launchAgentPath(spec)
  return {
    kind: 'launchd', name, write: [{ path, content: launchdPlist(spec) }], remove: [],
    commands: [
      { argv: ['launchctl', 'bootout', `${launchdDomain(spec)}/${name}`], allowFailure: true },
      { argv: ['launchctl', 'bootstrap', launchdDomain(spec), path] },
    ],
  }
}

function launchdRemove(spec: JobSpec): JobPlan {
  const name = jobName('launchd', spec.home)
  return {
    kind: 'launchd', name, write: [], remove: [launchAgentPath(spec)],
    commands: [{ argv: ['launchctl', 'bootout', `${launchdDomain(spec)}/${name}`], allowFailure: true }],
  }
}

// systemd --user (Linux)

const unitDir = (spec: JobSpec) => posix.join(spec.userHome, '.config', 'systemd', 'user')
const unitPaths = (spec: JobSpec) => {
  const name = jobName('systemd', spec.home)
  return { service: posix.join(unitDir(spec), `${name}.service`), timer: posix.join(unitDir(spec), `${name}.timer`) }
}

/** One systemd word: quoted, with `\`, `"`, `%` and `$` escaped so systemd passes it through literally. */
const unitWord = (value: string) =>
  `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`

export function systemdUnits(spec: JobSpec): { service: string; timer: string } {
  const { hour, minute } = parseTime(spec.time)
  const pad = (n: number) => String(n).padStart(2, '0')
  const env = [`JOBDUCK_HOME=${spec.home}`, ...(spec.pathEnv ? [`PATH=${spec.pathEnv}`] : [])]
  const service = [
    '[Unit]',
    `Description=Job Duck scheduled run for ${spec.home.replace(/%/g, '%%')}`,
    '',
    '[Service]',
    'Type=oneshot',
    `WorkingDirectory=${spec.workspace.replace(/%/g, '%%')}`,
    ...env.map((entry) => `Environment=${unitWord(entry)}`),
    `ExecStart=${runArgs(spec).map(unitWord).join(' ')}`,
    '',
  ].join('\n')
  const timer = [
    '[Unit]',
    `Description=Daily Job Duck run at ${spec.time}`,
    '',
    '[Timer]',
    `OnCalendar=*-*-* ${pad(hour)}:${pad(minute)}:00`,
    'Persistent=true',
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n')
  return { service, timer }
}

function systemdInstall(spec: JobSpec): JobPlan {
  const name = jobName('systemd', spec.home)
  const paths = unitPaths(spec)
  const units = systemdUnits(spec)
  return {
    kind: 'systemd', name,
    write: [{ path: paths.service, content: units.service }, { path: paths.timer, content: units.timer }],
    remove: [],
    commands: [
      { argv: ['systemctl', '--user', 'daemon-reload'] },
      { argv: ['systemctl', '--user', 'enable', '--now', `${name}.timer`] },
    ],
  }
}

function systemdRemove(spec: JobSpec): JobPlan {
  const name = jobName('systemd', spec.home)
  const paths = unitPaths(spec)
  return {
    kind: 'systemd', name, write: [], remove: [paths.timer, paths.service],
    commands: [{ argv: ['systemctl', '--user', 'disable', '--now', `${name}.timer`], allowFailure: true }],
    afterRemove: [{ argv: ['systemctl', '--user', 'daemon-reload'] }],
  }
}

export const SYSTEMD_PROBE = ['systemctl', '--user', 'show-environment']

// crontab (Linux without a systemd user manager)

const shellWord = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
/** cron turns an unescaped % into a newline. */
const cronSafe = (value: string) => value.replace(/%/g, '\\%')
const cronTag = (home: string) => `# ${jobName('crontab', home)}`

export function crontabLine(spec: JobSpec): string {
  const { hour, minute } = parseTime(spec.time)
  const env = [`JOBDUCK_HOME=${shellWord(spec.home)}`, ...(spec.pathEnv ? [`PATH=${shellWord(spec.pathEnv)}`] : [])]
  const command = `cd ${shellWord(spec.workspace)} && ${env.join(' ')} ${runArgs(spec).map(shellWord).join(' ')}`
  return `${minute} ${hour} * * * ${cronSafe(command)} ${cronTag(spec.home)}`
}

const withoutJob = (crontab: string, home: string) =>
  crontab.split('\n').filter((line) => line !== '' && !line.endsWith(cronTag(home)))

export const hasCrontabJob = (crontab: string, home: string) => crontab.split('\n').some((line) => line.endsWith(cronTag(home)))

export const currentCrontabLine = (crontab: string, home: string) =>
  crontab.split('\n').find((line) => line.endsWith(cronTag(home)))

function crontabWrite(lines: string[]): JobCommand {
  return { argv: ['crontab', '-'], input: lines.length === 0 ? '' : `${lines.join('\n')}\n` }
}

function crontabInstall(spec: JobSpec, crontab: string): JobPlan {
  return {
    kind: 'crontab', name: jobName('crontab', spec.home), write: [], remove: [],
    commands: [crontabWrite([...withoutJob(crontab, spec.home), crontabLine(spec)])],
  }
}

function crontabRemove(spec: JobSpec, crontab: string): JobPlan {
  return {
    kind: 'crontab', name: jobName('crontab', spec.home), write: [], remove: [],
    commands: [crontabWrite(withoutJob(crontab, spec.home))],
  }
}

export const CRONTAB_LIST = ['crontab', '-l']

// Task Scheduler (Windows)

export const windowsScriptPath = (spec: Pick<JobSpec, 'home'>) => win32.join(spec.home, 'schedule', 'run.cmd')

/** A batch-file word: quoted, with % doubled so cmd does not expand it. */
const batchWord = (value: string) => `"${value.replace(/%/g, '%%')}"`

export function windowsScript(spec: JobSpec): string {
  return [
    '@echo off',
    `cd /d ${batchWord(spec.workspace)}`,
    `set "JOBDUCK_HOME=${spec.home.replace(/%/g, '%%')}"`,
    runArgs(spec).map(batchWord).join(' '),
    '',
  ].join('\r\n')
}

function schtasksInstall(spec: JobSpec): JobPlan {
  const name = jobName('schtasks', spec.home)
  const script = windowsScriptPath(spec)
  const run = /\s/.test(script) ? `"${script}"` : script
  return {
    kind: 'schtasks', name, write: [{ path: script, content: windowsScript(spec) }], remove: [],
    commands: [{ argv: ['schtasks', '/Create', '/SC', 'DAILY', '/ST', spec.time, '/TN', name, '/TR', run, '/F'] }],
  }
}

function schtasksRemove(spec: JobSpec): JobPlan {
  const name = jobName('schtasks', spec.home)
  return {
    kind: 'schtasks', name, write: [], remove: [windowsScriptPath(spec)],
    commands: [{ argv: ['schtasks', '/Delete', '/TN', name, '/F'], allowFailure: true }],
  }
}

export const schtasksQuery = (home: string) => ['schtasks', '/Query', '/TN', jobName('schtasks', home)]

// Entry points

export interface PlatformState {
  platform: SchedulePlatform
  /** Linux: `systemctl --user` answers. */
  systemd?: boolean
  /** Linux: the current `crontab -l` (empty when there is none). */
  crontab?: string
}

export function linuxKind(state: PlatformState): 'systemd' | 'crontab' {
  return state.systemd ? 'systemd' : 'crontab'
}

export function installPlan(spec: JobSpec, state: PlatformState): JobPlan {
  parseTime(spec.time)
  if (state.platform === 'darwin') return launchdInstall(spec)
  if (state.platform === 'win32') return schtasksInstall(spec)
  return linuxKind(state) === 'systemd' ? systemdInstall(spec) : crontabInstall(spec, state.crontab ?? '')
}

/** Removal plans for every job kind this platform may hold. Linux returns systemd and crontab when both exist. */
export function removePlans(spec: JobSpec, state: PlatformState & { unitsPresent?: boolean }): JobPlan[] {
  if (state.platform === 'darwin') return [launchdRemove(spec)]
  if (state.platform === 'win32') return [schtasksRemove(spec)]
  const plans: JobPlan[] = []
  if (state.unitsPresent) plans.push(systemdRemove(spec))
  if (hasCrontabJob(state.crontab ?? '', spec.home)) plans.push(crontabRemove(spec, state.crontab ?? ''))
  return plans
}

export { launchAgentPath, unitPaths }
