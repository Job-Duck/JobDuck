import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { type Sandbox, migratedDb, sandbox } from './helpers'
import {
  runScheduleInstall, runScheduleRemove, runScheduleRun, runScheduleStatus, jobduckProgram,
} from '../src/commands/schedule'
import { loadPermissions, readStoredPermissions, writePermissions } from '../src/config/permissions'
import { handleApi } from '../src/dashboard/api'
import { createApplication, setStatus } from '../src/db/applications'
import { openDb } from '../src/db/client'
import { upsertPosting } from '../src/db/postings'
import { ABANDONED_ERROR, type ScheduledRun } from '../src/db/scheduled-runs'
import { HOST_IDS, hostById } from '../src/hosts'
import { dbPath, ensureHome, permissionsPath } from '../src/paths'
import { jobName, nextRunAt, scheduleHash } from '../src/schedule/jobs'
import { MAX_WINDOW_DAYS, postedWithinDays, schedulePrompt } from '../src/schedule/run'
import type { Exec, ExecResult, HostRunner, ScheduleFs } from '../src/schedule/system'
import { SETTINGS_GROUPS } from '../web/src/lib/forms'
import { runCounts as cardCounts, runTimeLine, scheduleLine, showScheduleCard } from '../web/src/lib/schedule'

let box: Sandbox
beforeEach(() => {
  box = sandbox()
  ensureHome(box.home)
})
afterEach(() => box.cleanup())

/** An in-memory file system: nothing the schedule commands write reaches the disk. */
function memoryFs(seed: Record<string, string> = {}): ScheduleFs & { files: Map<string, string> } {
  const files = new Map(Object.entries(seed))
  return {
    files,
    read: (path) => files.get(path) ?? null,
    write: (path, content) => void files.set(path, content),
    remove: (path) => void files.delete(path),
  }
}

interface Call {
  argv: string[]
  input?: string
}

/** A recording exec: never runs a real command. `answer` decides each result by the joined argv. */
function fakeExec(answer: (line: string) => Partial<ExecResult> = () => ({})): Exec & { calls: Call[] } {
  const calls: Call[] = []
  const exec = ((argv, options) => {
    calls.push({ argv, ...(options?.input === undefined ? {} : { input: options.input }) })
    return { code: 0, stdout: '', stderr: '', ...answer(argv.join(' ')) }
  }) as Exec & { calls: Call[] }
  exec.calls = calls
  return exec
}

const PROGRAM = ['/opt/jobduck/bin/jobduck']
const PATH_ENV = '/usr/local/bin:/usr/bin:/bin'

function deps(platform: NodeJS.Platform, exec: Exec, fs: ScheduleFs) {
  const out: string[] = []
  const err: string[] = []
  return {
    out, err,
    options: {
      workspace: box.workspace, home: box.home, platform, userHome: box.userHome, uid: 501, pathEnv: PATH_ENV, program: PROGRAM,
      exec, fs, out: (line: string) => out.push(line), err: (line: string) => err.push(line),
    },
  }
}

const setSchedule = (patch: Record<string, unknown>) => {
  const stored = readStoredPermissions(permissionsPath(box.home))
  writePermissions({ ...stored.permissions, schedule: { ...stored.permissions.schedule, ...patch } }, stored.revision,
    permissionsPath(box.home))
}

const schedule = () => loadPermissions(permissionsPath(box.home)).schedule
const mutating = (exec: { calls: Call[] }) =>
  exec.calls.filter(({ argv }) => !['crontab -l', 'systemctl --user show-environment'].includes(argv.join(' ')) && argv[1] !== '/Query')

const BYPASS = /dangerously|skip-permissions|bypass|yolo|full-auto|--yes\b|^-y$|approval-mode|permission-mode|--allowedTools|--allow-all/i

describe('install', () => {
  test('macOS writes a LaunchAgent plist for the configured time and bootstraps it in the gui domain', async () => {
    const exec = fakeExec()
    const fs = memoryFs()
    const { options } = deps('darwin', exec, fs)
    expect(await runScheduleInstall({ ...options, time: '07:30', host: 'claude' })).toBe(0)
    const label = jobName('launchd', box.home)
    const path = join(box.userHome, 'Library', 'LaunchAgents', `${label}.plist`)
    expect(label).toBe(`jobduck.schedule.${scheduleHash(box.home)}`)
    const plist = fs.files.get(path)!
    expect(plist).toContain(`<key>Label</key><string>${label}</string>`)
    expect(plist).toContain('<dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>30</integer></dict>')
    expect(plist).toContain(`<key>JOBDUCK_HOME</key><string>${box.home}</string>`)
    expect(plist).toContain(`<key>PATH</key><string>${PATH_ENV}</string>`)
    expect(plist).toContain(`<key>WorkingDirectory</key><string>${box.workspace}</string>`)
    for (const arg of [...PROGRAM, 'schedule', 'run', '--workspace', box.workspace]) expect(plist).toContain(`<string>${arg}</string>`)
    expect(exec.calls.map((call) => call.argv)).toEqual([
      ['launchctl', 'bootout', `gui/501/${label}`],
      ['launchctl', 'bootstrap', 'gui/501', path],
    ])
    expect(schedule()).toEqual({ enabled: true, time: '07:30', mode: 'find_only', host: 'claude' })
  })

  test('Linux with a systemd user manager writes a service and a timer and enables the timer', async () => {
    const exec = fakeExec()
    const fs = memoryFs()
    const { options } = deps('linux', exec, fs)
    expect(await runScheduleInstall({ ...options, time: '06:05' })).toBe(0)
    const name = jobName('systemd', box.home)
    const dir = join(box.userHome, '.config', 'systemd', 'user')
    const service = fs.files.get(join(dir, `${name}.service`))!
    const timer = fs.files.get(join(dir, `${name}.timer`))!
    expect(timer).toContain('OnCalendar=*-*-* 06:05:00')
    expect(timer).toContain('Persistent=true')
    expect(timer).toContain('WantedBy=timers.target')
    expect(service).toContain('Type=oneshot')
    expect(service).toContain(`Environment="JOBDUCK_HOME=${box.home}"`)
    expect(service).toContain(`WorkingDirectory=${box.workspace}`)
    expect(service).toContain(`ExecStart="${PROGRAM[0]}" "schedule" "run" "--workspace" "${box.workspace}"`)
    expect(mutating(exec).map((call) => call.argv)).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', `${name}.timer`],
    ])
    expect(schedule().enabled).toBe(true)
  })

  test('Linux without systemctl --user falls back to a tagged crontab line and keeps the other lines', async () => {
    const other = '0 1 * * * /usr/bin/true # mine\n'
    let crontab = other
    const exec = fakeExec((line) => {
      if (line === 'systemctl --user show-environment') return { code: 1, stderr: 'Failed to connect to bus' }
      if (line === 'crontab -l') return { stdout: crontab }
      return {}
    })
    const fs = memoryFs()
    const { options } = deps('linux', exec, fs)
    expect(await runScheduleInstall({ ...options, time: '21:45' })).toBe(0)
    const write = exec.calls.find((call) => call.argv.join(' ') === 'crontab -')!
    const tag = `# ${jobName('crontab', box.home)}`
    const lines = write.input!.trimEnd().split('\n')
    expect(lines[0]).toBe(other.trimEnd())
    expect(lines[1]).toStartWith(`45 21 * * * cd '${box.workspace}' && JOBDUCK_HOME='${box.home}' PATH='${PATH_ENV}' `)
    expect(lines[1]).toContain(`'${PROGRAM[0]}' 'schedule' 'run' '--workspace' '${box.workspace}'`)
    expect(lines[1]).toEndWith(tag)
    expect(fs.files.size).toBe(0)

    crontab = write.input!
    exec.calls.length = 0
    expect(await runScheduleInstall({ ...options, time: '22:00' })).toBe(0)
    const again = exec.calls.find((call) => call.argv.join(' ') === 'crontab -')!.input!.trimEnd().split('\n')
    expect(again).toHaveLength(2)
    expect(again[1]).toStartWith('0 22 * * * ')

    crontab = exec.calls.find((call) => call.argv.join(' ') === 'crontab -')!.input!
    exec.calls.length = 0
    expect(await runScheduleRemove(options)).toBe(0)
    expect(exec.calls.find((call) => call.argv.join(' ') === 'crontab -')!.input).toBe(other)
    expect(schedule().enabled).toBe(false)
  })

  test('Windows creates a daily Task Scheduler task for the time and a run.cmd that sets JOBDUCK_HOME', async () => {
    const exec = fakeExec()
    const fs = memoryFs()
    const { options } = deps('win32', exec, fs)
    expect(await runScheduleInstall({ ...options, time: '08:15' })).toBe(0)
    const name = jobName('schtasks', box.home)
    const [script, content] = [...fs.files.entries()][0]!
    expect(script).toEndWith('run.cmd')
    expect(content).toContain(`set "JOBDUCK_HOME=${box.home}"`)
    expect(content).toContain(`cd /d "${box.workspace}"`)
    expect(content).toContain(`"${PROGRAM[0]}" "schedule" "run" "--workspace" "${box.workspace}"`)
    expect(exec.calls.map((call) => call.argv)).toEqual([
      ['schtasks', '/Create', '/SC', 'DAILY', '/ST', '08:15', '/TN', name, '/TR', script!, '/F'],
    ])
  })

  test('--dry-run prints the files and commands and writes nothing', async () => {
    const before = readFileSync(permissionsPath(box.home), 'utf8')
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const exec = fakeExec()
      const fs = memoryFs()
      const { options, out } = deps(platform, exec, fs)
      expect(await runScheduleInstall({ ...options, dryRun: true })).toBe(0)
      expect(fs.files.size).toBe(0)
      expect(mutating(exec)).toEqual([])
      expect(out.some((line) => line.includes('JOBDUCK_HOME'))).toBe(true)
      expect(out.some((line) => line.startsWith('Would run: '))).toBe(true)
      expect(out.at(-1)).toBe('Dry run: nothing written or run.')
    }
    expect(readFileSync(permissionsPath(box.home), 'utf8')).toBe(before)
  })

  test('a bad --time is refused before anything is written', async () => {
    const exec = fakeExec()
    const fs = memoryFs()
    const { options, err } = deps('darwin', exec, fs)
    expect(await runScheduleInstall({ ...options, time: '25:00' })).toBe(2)
    expect(err[0]).toContain('HH:MM')
    expect(exec.calls).toEqual([])
    expect(schedule().enabled).toBe(false)
  })

  test('a failing scheduler command leaves [schedule] off', async () => {
    const exec = fakeExec((line) => (line.startsWith('launchctl bootstrap') ? { code: 5, stderr: 'Bootstrap failed' } : {}))
    const { options, err } = deps('darwin', exec, memoryFs())
    expect(await runScheduleInstall(options)).toBe(1)
    expect(err.at(-1)).toContain('Bootstrap failed')
    expect(schedule().enabled).toBe(false)
  })

  test('the default host is the first one registered for the workspace, else claude', async () => {
    const { options } = deps('darwin', fakeExec(), memoryFs())
    expect(await runScheduleInstall(options)).toBe(0)
    expect(schedule().host).toBe('claude')
  })
})

describe('remove and status', () => {
  test('macOS remove boots the job out and deletes the plist; --dry-run first changes nothing', async () => {
    const exec = fakeExec()
    const fs = memoryFs()
    const { options } = deps('darwin', exec, fs)
    await runScheduleInstall(options)
    expect(fs.files.size).toBe(1)
    exec.calls.length = 0
    expect(await runScheduleRemove({ ...options, dryRun: true })).toBe(0)
    expect(fs.files.size).toBe(1)
    expect(exec.calls).toEqual([])
    expect(schedule().enabled).toBe(true)

    expect(await runScheduleRemove(options)).toBe(0)
    expect(fs.files.size).toBe(0)
    expect(exec.calls.map((call) => call.argv)).toEqual([['launchctl', 'bootout', `gui/501/${jobName('launchd', box.home)}`]])
    expect(schedule().enabled).toBe(false)
  })

  test('Linux remove disables the timer, deletes both units and reloads systemd', async () => {
    const exec = fakeExec()
    const fs = memoryFs()
    const { options } = deps('linux', exec, fs)
    await runScheduleInstall(options)
    expect(fs.files.size).toBe(2)
    exec.calls.length = 0
    expect(await runScheduleRemove(options)).toBe(0)
    expect(fs.files.size).toBe(0)
    const name = jobName('systemd', box.home)
    expect(mutating(exec).map((call) => call.argv)).toEqual([
      ['systemctl', '--user', 'disable', '--now', `${name}.timer`],
      ['systemctl', '--user', 'daemon-reload'],
    ])
  })

  test('Windows remove deletes the task and run.cmd', async () => {
    const exec = fakeExec()
    const fs = memoryFs()
    const { options } = deps('win32', exec, fs)
    await runScheduleInstall(options)
    exec.calls.length = 0
    expect(await runScheduleRemove(options)).toBe(0)
    expect(fs.files.size).toBe(0)
    expect(mutating(exec).map((call) => call.argv)).toEqual([['schtasks', '/Delete', '/TN', jobName('schtasks', box.home), '/F']])
  })

  test('remove with no job installed only turns the setting off', async () => {
    setSchedule({ enabled: true })
    const exec = fakeExec((line) => (line.startsWith('schtasks /Query') ? { code: 1 } : {}))
    const { options, out } = deps('win32', exec, memoryFs())
    expect(await runScheduleRemove(options)).toBe(0)
    expect(out[0]).toBe('No OS job is installed for this Job Duck home.')
    expect(mutating(exec)).toEqual([])
    expect(schedule().enabled).toBe(false)
  })

  test('status reports the job, the next run, an out-of-date job and the last run', async () => {
    const fs = memoryFs()
    const now = new Date(2026, 10, 17, 9, 0)
    const { options, out } = deps('darwin', fakeExec(), fs)
    await runScheduleInstall({ ...options, time: '08:00' })
    expect(await runScheduleStatus({ ...options, now: () => now })).toBe(0)
    expect(out).toContain(`Job: launchd ${jobName('launchd', box.home)} installed`)
    expect(out).toContain(`Next run: ${new Date(2026, 10, 18, 8, 0).toLocaleString()}`)
    expect(out).toContain('Last run: none yet')

    setSchedule({ time: '09:30' })
    const db = migratedDb(box.home)
    db.prepare(`INSERT INTO scheduled_runs (started_at, finished_at, mode, host, exit_code, found, applied, pending)
      VALUES ('2026-11-16T13:00:00.000Z', '2026-11-16T13:20:00.000Z', 'find_only', 'claude', 0, 4, 0, 1)`).run()
    db.close()
    out.length = 0
    await runScheduleStatus({ ...options, now: () => now })
    expect(out.some((line) => line.startsWith('The installed job differs from [schedule]'))).toBe(true)
    expect(out.at(-1)).toContain('found 4, applied 0, pending 1')
  })

  test('nextRunAt is later today before the time and tomorrow after it', () => {
    expect(nextRunAt('08:00', new Date(2026, 0, 5, 7, 59))).toEqual(new Date(2026, 0, 5, 8, 0))
    expect(nextRunAt('08:00', new Date(2026, 0, 5, 8, 0))).toEqual(new Date(2026, 0, 6, 8, 0))
  })
})

describe('run', () => {
  const runs = () => {
    const db = openDb(dbPath(box.home))
    const rows = db.prepare('SELECT * FROM scheduled_runs ORDER BY id').all() as ScheduledRun[]
    db.close()
    return rows
  }

  function runOptions(runHost: HostRunner, extra: Record<string, unknown> = {}) {
    const out: string[] = []
    const err: string[] = []
    return {
      out, err,
      options: {
        workspace: box.workspace, home: box.home, userHome: box.userHome, runHost, env: { PATH: PATH_ENV },
        out: (line: string) => out.push(line), err: (line: string) => err.push(line), ...extra,
      },
    }
  }

  test('a run records a finished row with the exit code and the database changes the host made', async () => {
    setSchedule({ enabled: true, host: 'claude', mode: 'find_only' })
    const seen: { argv: string[]; cwd: string; home?: string }[] = []
    const runHost: HostRunner = async (argv, options) => {
      seen.push({ argv, cwd: options.cwd, home: options.env.JOBDUCK_HOME })
      const db = openDb(dbPath(box.home))
      const posting = (n: number) => upsertPosting(db, {
        source: 'agent', url: `https://example.com/jobs/${n}`, title: `Engineer ${n}`, company: 'Acme',
      })
      createApplication(db, { postingId: posting(1).id })
      const second = createApplication(db, { postingId: posting(2).id })
      createApplication(db, { postingId: posting(3).id, status: 'pending', pendingReason: 'Solve the CAPTCHA, then tell me to continue.' })
      setStatus(db, second.id, 'applied')
      db.close()
      return { exitCode: 0, timedOut: false }
    }
    const { options } = runOptions(runHost)
    expect(await runScheduleRun(options)).toBe(0)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.argv.slice(0, 2)).toEqual(['claude', '-p'])
    expect(seen[0]!.argv[2]).toContain('Job Duck scheduled run, mode: find_only')
    expect(seen[0]!.argv[2]).toContain(`posted_within_days: ${MAX_WINDOW_DAYS}`)
    expect(seen[0]!.cwd).toBe(box.workspace)
    expect(seen[0]!.home).toBe(box.home)
    const [row] = runs()
    expect(row).toMatchObject({ mode: 'find_only', host: 'claude', exit_code: 0, found: 3, applied: 1, pending: 1, error: null })
    expect(row!.finished_at).not.toBeNull()
    const logs = readdirSync(join(box.home, 'logs'))
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(/^schedule-\d{4}-\d{2}-\d{2}\.log$/)
    expect(readFileSync(join(box.home, 'logs', logs[0]!), 'utf8')).toContain('found 3, applied 1, pending 1')
  })

  test('the next run searches since the last successful one', async () => {
    setSchedule({ enabled: true, host: 'codex', mode: 'apply' })
    const db = migratedDb(box.home)
    const yesterday = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString()
    db.prepare(`INSERT INTO scheduled_runs (started_at, finished_at, mode, host, exit_code)
      VALUES (?, ?, 'apply', 'codex', 0)`).run(yesterday, yesterday)
    db.close()
    let prompt = ''
    const { options } = runOptions(async (argv) => {
      expect(argv.slice(0, 2)).toEqual(['codex', 'exec'])
      prompt = argv[2]!
      return { exitCode: 0, timedOut: false }
    })
    expect(await runScheduleRun(options)).toBe(0)
    expect(prompt).toContain('Job Duck scheduled run, mode: apply')
    expect(prompt).toContain('posted_within_days: 2')
    expect(prompt).toContain(`the last scheduled run started ${yesterday}`)
  })

  test('a run in flight for less than 2 hours refuses a second one; an older one is closed as abandoned', async () => {
    setSchedule({ enabled: true, host: 'claude' })
    const db = migratedDb(box.home)
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    db.prepare("INSERT INTO scheduled_runs (started_at, mode, host) VALUES (?, 'find_only', 'claude')").run(tenMinutesAgo)
    db.close()
    let called = 0
    const host: HostRunner = async () => {
      called++
      return { exitCode: 0, timedOut: false }
    }
    const { options, err } = runOptions(host)
    expect(await runScheduleRun(options)).toBe(1)
    expect(called).toBe(0)
    expect(err[0]).toContain('is still going')
    expect(runs()).toHaveLength(1)

    const later = new Date(Date.now() + 3 * 60 * 60 * 1000)
    expect(await runScheduleRun({ ...options, now: () => later })).toBe(0)
    expect(called).toBe(1)
    const [old, fresh] = runs()
    expect(old).toMatchObject({ error: ABANDONED_ERROR, exit_code: null })
    expect(old!.finished_at).not.toBeNull()
    expect(fresh).toMatchObject({ exit_code: 0, error: null })
  })

  test('a host that cannot start leaves exit_code null and the error set', async () => {
    setSchedule({ enabled: true, host: 'gemini' })
    const { options } = runOptions(async () => {
      throw new Error('gemini is not on PATH')
    })
    expect(await runScheduleRun(options)).toBe(1)
    const [row] = runs()
    expect(row).toMatchObject({ host: 'gemini', exit_code: null, error: 'could not start gemini: gemini is not on PATH' })
    expect(row!.finished_at).not.toBeNull()
  })

  test('a timeout and a non-zero exit are recorded as errors', async () => {
    setSchedule({ enabled: true, host: 'claude' })
    const timedOut = runOptions(async () => ({ exitCode: 143, timedOut: true }), { timeoutMs: 45 * 60 * 1000 })
    expect(await runScheduleRun(timedOut.options)).toBe(1)
    const failed = runOptions(async () => ({ exitCode: 2, timedOut: false }))
    expect(await runScheduleRun(failed.options)).toBe(1)
    const [first, second] = runs()
    expect(first).toMatchObject({ exit_code: 143, error: 'timed out after 45 min and was stopped' })
    expect(second).toMatchObject({ exit_code: 2, error: 'the agent host exited with code 2' })
  })

  test('a run while [schedule] is off records nothing and starts nothing', async () => {
    let called = false
    const { options, out } = runOptions(async () => {
      called = true
      return { exitCode: 0, timedOut: false }
    })
    expect(await runScheduleRun(options)).toBe(0)
    expect(called).toBe(false)
    expect(out[0]).toContain('[schedule] enabled = false')
    expect(existsSync(dbPath(box.home))).toBe(false)
  })

  test('--dry-run prints the host command and records nothing', async () => {
    setSchedule({ enabled: true, host: 'claude' })
    const { options, out } = runOptions(async () => {
      throw new Error('must not run')
    }, { dryRun: true })
    expect(await runScheduleRun(options)).toBe(0)
    expect(out.some((line) => line.startsWith('claude -p "Job Duck scheduled run, mode: find_only'))).toBe(true)
    expect(existsSync(dbPath(box.home))).toBe(false)
  })

  test('postedWithinDays is at least 1 and at most the default window', () => {
    const now = new Date('2026-11-17T08:00:00.000Z')
    expect(postedWithinDays(null, now)).toBe(MAX_WINDOW_DAYS)
    expect(postedWithinDays('2026-11-17T07:00:00.000Z', now)).toBe(1)
    expect(postedWithinDays('2026-11-15T07:00:00.000Z', now)).toBe(3)
    expect(postedWithinDays('2026-10-01T07:00:00.000Z', now)).toBe(MAX_WINDOW_DAYS)
  })
})

test('no host command or prompt carries a permission-bypass flag', () => {
  const now = new Date()
  for (const id of HOST_IDS) {
    for (const mode of ['find_only', 'apply'] as const) {
      const argv = hostById(id).headless(schedulePrompt(mode, null, now))
      expect(argv).toHaveLength(3)
      for (const arg of argv.slice(0, -1)) expect(arg).not.toMatch(BYPASS)
    }
  }
  expect(hostById('claude').headless('x')).toEqual(['claude', '-p', 'x'])
  expect(hostById('codex').headless('x')).toEqual(['codex', 'exec', 'x'])
  expect(hostById('gemini').headless('x')).toEqual(['gemini', '-p', 'x'])
})

test('jobduckProgram is the binary alone, or bun plus the script when run from source', () => {
  expect(jobduckProgram('/opt/jobduck/bin/jobduck', '/$bunfs/root/jobduck')).toEqual(['/opt/jobduck/bin/jobduck'])
  expect(jobduckProgram('/opt/bun/bin/bun', '/src/jobduck/src/cli.ts')).toEqual(['/opt/bun/bin/bun', '/src/jobduck/src/cli.ts'])
})

describe('dashboard', () => {
  const get = (path: string) => {
    const db = migratedDb(box.home)
    try {
      return handleApi({ db, home: box.home, workspace: box.workspace }, { method: 'GET', path, query: new URLSearchParams(), body: undefined })
    } finally {
      db.close()
    }
  }

  test('GET /api/schedule returns the settings and the last run, null before the first', () => {
    setSchedule({ enabled: true, time: '07:00', host: 'gemini' })
    expect(get('/api/schedule')).toEqual({
      status: 200,
      body: { settings: { enabled: true, time: '07:00', mode: 'find_only', host: 'gemini', host_set: true }, last_run: null },
    })
    const db = migratedDb(box.home)
    db.prepare(`INSERT INTO scheduled_runs (started_at, finished_at, mode, host, exit_code, found, applied, pending, error)
      VALUES ('2026-11-16T08:00:00.000Z', '2026-11-16T08:30:00.000Z', 'apply', 'gemini', 1, 2, 1, 3, 'boom')`).run()
    db.prepare(`INSERT INTO scheduled_runs (started_at, finished_at, mode, host, exit_code, found, applied, pending)
      VALUES ('2026-11-17T08:00:00.000Z', '2026-11-17T08:30:00.000Z', 'find_only', 'gemini', 0, 5, 0, 0)`).run()
    db.close()
    const { body } = get('/api/schedule') as { body: { last_run: ScheduledRun } }
    expect(body.last_run).toMatchObject({ started_at: '2026-11-17T08:00:00.000Z', found: 5, applied: 0, pending: 0, error: null })
    expect(get('/api/schedule').status).toBe(200)
    const db2 = migratedDb(box.home)
    expect(handleApi({ db: db2, home: box.home }, { method: 'POST', path: '/api/schedule', query: new URLSearchParams(), body: {} }).status).toBe(405)
    db2.close()
  })

  test('the card shows the counts, the time and the error, and hides with no run while off', () => {
    const run: ScheduledRun = {
      id: 1, started_at: '2026-11-17T08:00:00.000Z', finished_at: '2026-11-17T08:20:00.000Z', mode: 'apply', host: 'claude',
      exit_code: 1, found: 2, applied: 1, pending: 3, error: 'boom',
    }
    const settings = { enabled: true, time: '08:00', mode: 'apply' as const, host: 'claude', host_set: true }
    expect(showScheduleCard(null)).toBe(false)
    expect(showScheduleCard({ settings: { ...settings, enabled: false }, last_run: null })).toBe(false)
    expect(showScheduleCard({ settings, last_run: null })).toBe(true)
    expect(cardCounts(run)).toEqual([{ label: 'Found', value: 2 }, { label: 'Applied', value: 1 }, { label: 'Pending', value: 3 }])
    expect(runTimeLine(run)).toBe(`${new Date(run.started_at).toLocaleString()} · Apply with Claude Code`)
    expect(runTimeLine({ ...run, finished_at: null })).toStartWith('Running since ')
    expect(scheduleLine({ settings, last_run: run })).toBe('Runs Daily At 08:00')
  })

  test('Settings offers enabled, time, mode and host under Scheduled Runs', () => {
    const group = SETTINGS_GROUPS.find((candidate) => candidate.title === 'Scheduled Runs')!
    expect(group.fields.map((field) => field.key)).toEqual(['schedule.enabled', 'schedule.time', 'schedule.mode', 'schedule.host'])
    expect(group.fields.find((field) => field.key === 'schedule.host')!.options!.map(([value]) => value)).toEqual([...HOST_IDS])
  })
})
