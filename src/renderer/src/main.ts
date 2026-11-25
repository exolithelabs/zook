import { mount } from 'svelte'
import App from './App.svelte'
import './app.css'

// Uncaught errors are recorded in main.log as well as the console, to make problems users hit findable.
function describe(error: unknown): string {
  return error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error)
}
window.addEventListener('error', (e) => {
  window.zook.logs.error(e.error ? describe(e.error) : `${e.message} (${e.filename}:${e.lineno})`)
})
window.addEventListener('unhandledrejection', (e) => {
  window.zook.logs.error(`Unhandled rejection: ${describe(e.reason)}`)
})

export default mount(App, { target: document.getElementById('app')! })
