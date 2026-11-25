import type { UpdateStatus } from '../../main/updater'
import { errorMessage } from './errors'

// What finishing a downloaded update does, for buttons.
export function installLabel(status: UpdateStatus): string {
  if (status.install === 'appimage') return 'Restart to update'
  return status.platform === 'mac' ? 'Open installer' : 'Run installer'
}

export function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`
}

class Updates {
  // As main last reported it; null until loaded.
  status = $state<UpdateStatus | null>(null)
  // A failure from the renderer's own request, such as main being unreachable.
  error = $state('')
  // The release the banner was closed for, this session. A newer one shows it again.
  dismissed = $state<string | null>(null)

  // The release the banner offers, if it should show.
  get banner() {
    const state = this.status?.state
    if (!state || !('release' in state) || !state.release) return null
    return state.release.version === this.dismissed ? null : state.release
  }

  listen(): () => void {
    window.zook.updates.get().then((s) => (this.status = s))
    return window.zook.updates.onState((s) => (this.status = s))
  }

  private async run(action: () => Promise<UpdateStatus>) {
    this.error = ''
    try {
      this.status = await action()
    } catch (err) {
      this.error = errorMessage(err)
    }
  }

  check = () => this.run(() => window.zook.updates.check())
  download = () => this.run(() => window.zook.updates.download())
  setAuto = (enabled: boolean) => this.run(() => window.zook.updates.setAuto(enabled))
  cancel = () => window.zook.updates.cancel()
  install = () => this.run(() => window.zook.updates.install())
}

export const updates = new Updates()
