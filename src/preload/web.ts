import { ipcRenderer } from 'electron'

// Runs in an isolated world inside the web pages shown in popups, and exposes nothing to them.
// A plain left-click on a link that the page didn't handle itself (single-page apps route their own
// links) is sent to Zook to open in a new popup on top. Forms, redirects and script navigations
// are left to load in place.
window.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return
  const link = (e.target as Element | null)?.closest?.('a[href]')
  if (!link || link.hasAttribute('download')) return
  let url: URL
  try {
    url = new URL(link.getAttribute('href')!, document.baseURI)
  } catch {
    return
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return
  // Jumps within the same page stay in place.
  if (url.hash && url.href.split('#')[0] === location.href.split('#')[0]) return
  e.preventDefault()
  ipcRenderer.send('page:link', url.href)
})
