import { type ScheduleSettings, readStoredPermissions } from '../config/permissions'
import { type HostId, allHosts } from '../hosts'
import { permissionsPath } from '../paths'

export interface EffectiveSchedule {
  enabled: boolean
  time: string
  mode: ScheduleSettings['mode']
  host: HostId
  /** True when `host` came from `[schedule] host`, false when it was picked as the first registered host. */
  host_set: boolean
}

/** The first host registered for the workspace (its MCP entry is in place), else Claude Code. */
export function defaultHost(workspace: string, home: string, userHome?: string): HostId {
  const ctx = { workspace, home, userHome, dryRun: true }
  return allHosts().find((host) => {
    try {
      return host.isRegistered(ctx)
    } catch {
      return false
    }
  })?.id ?? 'claude'
}

export function effectiveSchedule(settings: ScheduleSettings, workspace: string, home: string, userHome?: string): EffectiveSchedule {
  return {
    enabled: settings.enabled,
    time: settings.time,
    mode: settings.mode,
    host: settings.host ?? defaultHost(workspace, home, userHome),
    host_set: settings.host !== undefined,
  }
}

export function readSchedule(home: string, workspace: string, userHome?: string): EffectiveSchedule {
  return effectiveSchedule(readStoredPermissions(permissionsPath(home)).permissions.schedule, workspace, home, userHome)
}
