# Zook

Zook is a desktop search app. You search with the search API of your choice, ask an AI model of your choice, and read results in an in-app browser. It runs on Linux, macOS and Windows and is built with Electron and Svelte.

## Features

- **Search with your own API key.** Supported providers: Brave Search, SerpAPI, Google Programmable Search, Exa, Tavily and Parallel. Each provider gets its own results types (web, news, images and videos) where it supports them.
- **AI chat with web research.** The model can search the web and read pages while it answers, then cite numbered sources. It works with OpenAI, Anthropic, Google Gemini, xAI, DeepSeek, OpenRouter, OpenCode Go, a local Ollama, or any custom endpoint. See [AI chat](#ai-chat).
- **In-app browser.** Results open in stacked popups with their own isolated session. Links can be opened on top of each other, sent to your system browser, or used as a new search.
- **Ad and tracker blocking** in web pages, using Ghostery's blocker. You can turn it off in Settings.
- **History and suggestions.** Past searches and visited pages power address-bar suggestions. Brave Autosuggest can add online suggestions.
- **Keys stay on your device.** API keys are encrypted with your system keyring (Keychain, Windows DPAPI, or a Secret Service such as GNOME Keyring or KWallet on Linux). Keys go only to the service they belong to.
- **Signed in-app updates** from GitHub Releases. See [Releases and updates](#releases-and-updates).

Keyboard shortcuts: <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>L</kbd> focuses the address bar, and <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>H</kbd> opens history.

## Install

Download the build for your system from the [latest release](https://github.com/exolithelabs/zook/releases/latest):

| System | File | Notes |
| --- | --- | --- |
| Linux | `Zook-<version>-x86_64.AppImage` (or `arm64`) | Make it executable (`chmod +x`) and run it. The AppImage updates itself. |
| macOS | `Zook-<version>-arm64.dmg` (Apple silicon) or `-x64.dmg` (Intel) | Open it and drag Zook into Applications. |
| Windows | `Zook-Setup-<version>-x64.exe` (or `arm64`) | Run the installer. |

Before your first search, add a search provider's API key in Settings. If you search without one, Zook opens Settings for you. Each provider's entry links to where you can get a key. AI chat is optional and is set up in its own Settings section.

## AI chat

Open the chat sidebar and ask a question. When web search is on, the model gets two tools:

- `web_search` runs a query through your search provider and returns numbered sources.
- `read_page` fetches a page's text when a snippet isn't enough, or when you paste a URL. It won't read local or private-network addresses.

A reply can take up to six rounds of searching and reading. Citations such as `[3]` point to the same source for the whole conversation, and the sources are listed under each reply. Some backends reject tool calls, as some local and compatible servers do. For those, Zook runs one search first and gives the results to the model. You can turn web search off in Settings to chat without it.

In a conversation you can stop a reply with <kbd>Esc</kbd>, edit an earlier message, copy a reply, or ask again. Conversations are saved in the sidebar, where you can search them by title, rename them and delete them.

### Backends

Add one or more backends in **Settings → AI chat** and pick the one to use. Zook checks the key when you save, and it can list the backend's chat models.

| Backend | API used | Default model | Notes |
| --- | --- | --- | --- |
| OpenAI | OpenAI chat completions | `gpt-4o-mini` | |
| Anthropic | Anthropic Messages | `claude-sonnet-5-5` | Use a key scoped to a workspace. |
| Google Gemini | Gemini API | `gemini-3.8-flash` | |
| xAI | OpenAI-compatible | `grok-4.7` | Reasons before answering, so replies can start slowly. |
| DeepSeek | OpenAI-compatible | `deepseek-flash` | Thinking mode is on by default. |
| OpenRouter | OpenAI-compatible | `openrouter/auto` | Any model slug works. |
| OpenCode Go | OpenAI-compatible | `glm-5.3` | Needs a Console API key from a workspace subscribed to Go. |
| Ollama (local) | OpenAI-compatible | `llama3.2` | Needs no key. Pull the model first, for example `ollama pull llama3.2`. |
| Custom | You choose: OpenAI-compatible, Anthropic Messages or Gemini | — | Any base URL. The key is optional. |

Replies are streamed. Your questions, plus the search results and pages the model reads, go only to the backend you chose.

## Build from source

You need Node.js 20.19 or newer (or 22.12 or newer) and npm.

```sh
npm install
npm run dev         # run with hot reload
npm run typecheck   # check types in the main process, preload and UI
npm run build       # build into out/, including the license notices
npm run dist        # build and package for the current OS into dist/
```

To run in development without opening Settings, you can copy `.env.example` to `.env` and fill in keys there. That includes an AI chat backend, set with `ZOOK_CHAT_BASE_URL`, `ZOOK_CHAT_MODEL` and `ZOOK_CHAT_API_KEY`. The backend must be OpenAI-compatible. Keys saved in Settings take priority over `.env`.

Each platform's package must be built on that platform: the AppImage on Linux, the `.dmg` and `.zip` on macOS, and the NSIS installer on Windows. The electron-builder configuration lives in the `build` section of `package.json`.

The **CI** workflow (`.github/workflows/ci.yml`) runs `npm run typecheck` and `npm run build` on every push and pull request.

### Project layout

```
src/main/           Electron main process: windows, search providers, chat backends (chat.ts),
                    chat web tools (research.ts), stores, updater, security
src/preload/        The bridge exposed to the UI (index.ts) and the script injected into web pages (web.ts)
src/renderer/       The Svelte UI
scripts/            Release signing (release.mjs) and license notice collection (licenses.mjs)
.github/workflows/  CI (ci.yml) and the tag-triggered release (release.yml)
```

## Releases and updates

Zook checks GitHub Releases for updates. It trusts a release only if it is signed with the project's Ed25519 key.

Each release includes these files:

- the builds for each platform;
- `release.json`, which lists every build with its size and SHA-512 hash;
- `release.json.sig`, an Ed25519 signature of `release.json`'s exact bytes.

The app checks the signature against the public key in `src/main/update-key.ts` before it reads anything in the manifest. It offers only versions newer than the one running, and it never installs or opens a download whose size and hash don't match. How the update finishes depends on the system:

- **Linux (AppImage):** the new AppImage replaces the running one in place. **Restart** starts the new version.
- **macOS:** the `.dmg` is downloaded and checked, then opened so you can drag the new version into Applications.
- **Windows:** the setup `.exe` is downloaded and checked, then run.
- **Other copies** (development builds, a Linux copy that isn't the AppImage, or one in a folder Zook can't write to) still say when an update exists and link to the release.

Checks run in the background about every 6 hours. You can turn this off, or check by hand, in **Settings → Updates**.

### Cutting a release

Releases are built and published by the **Release** workflow (`.github/workflows/release.yml`) when you push a `v*` tag.

**One-time setup:**

1. Make the signing key:
   ```sh
   npm run release:keygen
   ```
   The private key is written to `~/.config/zook-release/ed25519.pem`, or to `$ZOOK_RELEASE_KEY` if that is set. The public key is written into `src/main/update-key.ts`; commit that file. Back up the private key and never commit it. If you lose it, installed copies can't trust new releases.
2. Add the private key's full PEM text as a repository secret named `ZOOK_RELEASE_KEY`:
   ```sh
   gh secret set ZOOK_RELEASE_KEY < ~/.config/zook-release/ed25519.pem
   ```

**Each release:**

1. Bump `version` in `package.json` and commit it.
2. Tag that commit `v<version>` and push the tag. An annotated tag's message becomes the release notes. A lightweight tag uses the tagged commit's message instead.
   ```sh
   git tag -a v0.2.0 -m "What changed in this release"
   git push origin v0.2.0
   ```

The workflow then does the following:

1. **Build.** It runs `npm run dist` on Ubuntu, macOS and Windows at the same time. If the tag doesn't match `package.json`'s version, it fails.
2. **Sign.** It gathers every build, fails if the AppImage, `.dmg`, `.zip` or `.exe` is missing, and signs `release.json` with the `ZOOK_RELEASE_KEY` secret.
3. **Publish.** It creates the GitHub release `v<version>` on `exolithelabs/zook` and uploads the builds, `release.json` and `release.json.sig`.

A version with a hyphen, such as `0.2.0-beta.1`, is published as a prerelease. The app only looks at the latest normal release, so installed copies won't be offered a prerelease.

**Releasing by hand** still works if you can't use the workflow. Build with `npm run dist` on each platform and gather the files into one `dist/` folder. Then run `npm run release:sign -- --notes-file CHANGES.md` (or `--notes "…"`, and `--dir` to sign another folder). The script checks that your private key matches the public key in the app, warns about any missing platform, and prints the `gh release create` command to run. Publish it as a normal release, not a draft or prerelease.

The updater checks Zook's own signature. It doesn't replace the operating system's code signing. Without Apple signing and notarization, macOS Gatekeeper will block the app. Without an Authenticode certificate, Windows SmartScreen will warn about the installer.

## Security and privacy

- Only one copy of Zook runs at a time. Launching it again focuses the open window.
- Every window and page runs sandboxed with context isolation and no Node.js access. `<webview>` is blocked. Web pages can only navigate to `http(s)` addresses, and they have no permissions beyond clipboard writes, fullscreen and pointer lock.
- Links that leave the app go to the system only when they are `http`, `https` or `mailto` links.
- The UI is served with a strict Content-Security-Policy. A packaged build checks for it at startup and refuses to run without it.
- Settings, history and chats are stored as JSON in the app's data folder. Each store has a version, is migrated with a backup first, and is written atomically.
- **Logs:** errors, warnings and crash information go to `main.log` in the app's logs folder (**Settings → General → Logs**), with likely API keys masked. Native crash dumps are kept locally and are never uploaded.

## License

Zook is licensed under the [Apache License 2.0](LICENSE). It includes open-source software under its own licenses: Electron, Chromium, Node.js and the npm packages it ships. `npm run build` collects their notices into `out/licenses/`, and you can read them in **Settings → Licenses**.
