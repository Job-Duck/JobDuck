import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * The real machine behind `jobduck schedule`: a synchronous exec for the OS scheduler commands, a small file system
 * and the agent host runner. Commands take these as injectable dependencies; tests always pass fakes.
 */

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export type Exec = (argv: string[], options?: { input?: string }) => ExecResult

export interface ScheduleFs {
  read(path: string): string | null
  write(path: string, content: string): void
  remove(path: string): void
}

export interface HostRunOptions {
  cwd: string
  env: Record<string, string | undefined>
  timeoutMs: number
  logPath: string
}

export interface HostRunResult {
  exitCode: number | null
  timedOut: boolean
}

/** Runs the agent host headless; throws when it cannot start (not on PATH, not executable). */
export type HostRunner = (argv: string[], options: HostRunOptions) => Promise<HostRunResult>

export const systemExec: Exec = (argv, options = {}) => {
  try {
    const result = Bun.spawnSync(argv, {
      stdin: options.input === undefined ? 'ignore' : Buffer.from(options.input),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return { code: result.exitCode ?? 1, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
  } catch (error) {
    return { code: 127, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
  }
}

export const systemFs: ScheduleFs = {
  read: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null),
  write: (path, content) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content, { mode: 0o600 })
    chmodSync(path, 0o600)
  },
  remove: (path) => rmSync(path, { force: true }),
}

/** PATH from an environment, matched case-insensitively: Windows spells it `Path`. */
export function pathOf(env: Record<string, string | undefined>): string {
  return env.PATH ?? Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
}

export const spawnHost: HostRunner = async (argv, options) => {
  const [command, ...args] = argv
  const binary = command === undefined ? null : Bun.which(command, { PATH: pathOf(options.env) })
  if (binary === null) throw new Error(`${command ?? '(no command)'} is not on PATH`)
  mkdirSync(dirname(options.logPath), { recursive: true, mode: 0o700 })
  const log = openSync(options.logPath, 'a', 0o600)
  try {
    const proc = Bun.spawn([binary, ...args], { cwd: options.cwd, env: options.env, stdin: 'ignore', stdout: log, stderr: log })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, options.timeoutMs)
    try {
      const code = await proc.exited
      return { exitCode: proc.signalCode ? null : code, timedOut }
    } finally {
      clearTimeout(timer)
    }
  } finally {
    closeSync(log)
  }
}
