// IPC errors arrive as "Error invoking remote method 'x': Error: message"; keep just the message.
export function errorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
