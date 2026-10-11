# Mini Browser

A small Windows browser that stays out of your way. Resize it from any edge, move it with the tab strip, and use the top-strip pin to keep it above other apps.

## Open the browser

For a normal Windows installation, run **[Mini-Browser-Setup-1.7.4-x64.exe](dist/Mini-Browser-Setup-1.7.4-x64.exe)**. The setup wizard lets you choose a folder and creates desktop and Start menu shortcuts. Install it for your Windows account; administrator access is not required. Run the new installer to update an existing installation. Remove it through Windows Settings > Apps when needed.

The installed version stores cookies, bookmarks, website storage, cache, and window settings in `%APPDATA%\Mini Browser`, separately from the program files, so reinstalling or updating does not overwrite your profile. Uninstalling retains that profile. The installed version starts with a new profile and does not import data from an extracted portable copy.

An optional portable edition can be built from source with `npm run build`. This creates `dist/Mini-Browser-Windows-x64.zip`; extract it to a writable folder and open **Mini Browser.exe** inside the extracted folder.

The Windows x64 app is portable: no installation or Node.js is required. Keep all extracted files together. Move the entire folder to another location or a USB drive to take its browsing data with you. Saved passwords use Windows account encryption and cannot be transferred to another Windows account or computer.

The workspace contains the source code, build/test scripts, dependency lockfile, and release packages. Temporary build dependencies, caches, test results, and staging folders are removed after delivery.

## Use it

- Type a website address in the toolbar and press Enter. Addresses such as `example.com` default to HTTPS; full HTTP/HTTPS addresses and local development addresses also work.
- There is no default search engine, automatic search, or external startup page. Typing matches bookmarks and history in the current profile; use the arrow keys and Enter to open a suggestion. Unmatched plain text prompts you to enter a website address. Use a search website directly for web search.
- The three-dot menu contains Zoom, Find, Downloads, History, Bookmarks, Passwords, Print, Clear browsing data, and Exit. Pin and Auto-hide controls sit on the top tab strip.
- Closing a window leaves Mini Browser running in the Windows system tray. Double-click its tray icon, select **Open Mini Browser**, or launch its shortcut to reopen it. **Exit** in the three-dot menu or tray menu quits the entire app and closes all windows.
- Drag the title bar to move the window and any edge or corner to resize it.
- Use the back, forward, and reload buttons to navigate. Each tab keeps its own history and page state.
- Downloads save to your Windows Downloads folder. Existing filenames get a numeric suffix. The small downloads panel shows progress, cancellation, blocked automatic downloads, errors, and completed-file actions. The first automatic download per tab is allowed; further automatic downloads wait until you interact with the page. Potentially executable or script files ask for a second confirmation before opening. Completed downloads receive a Windows Internet Zone marker when supported. Click the download icon beside the address bar, or Downloads in the menu, to reopen its floating bubble. Each window shows only downloads it started in its own profile; closing it cancels unfinished downloads. Download history is kept for that window's lifetime.
- Press **Ctrl+F** to find text in the current page. **Enter** and **Shift+Enter** move forward and backward; **Esc** closes the bar and clears highlights.
- **Ctrl+Plus**, **Ctrl+Minus**, and **Ctrl+0** zoom the current tab in, out, or back to 100%. Zoom stays between 50% and 300% and never changes another tab, including another tab on the same website.
- Right-click a page for applicable navigation and editing actions. Links offer copy, open in a new tab, and download; images offer download.
- Click **+** on the top strip to add a tab; click a tab to switch, or its **×** to close it. Ordinary new-tab links open in the same floating window. Explicit popups, including sized login windows, open as small child windows in the same profile session, show their site origin with the page title, and close with their parent browser. Popups without a recent user action are blocked with a notice. Tabs in a profile share its cookies and local storage, while keeping separate session storage.
- Click the small window icon on the top tab strip, or press **Ctrl+Shift+H**, to auto-hide browser UI. The title bar, tabs, and toolbar hide while the floating window keeps its size and position. Move the mouse near its top edge to reveal controls; move away to hide them. The address bar stays visible while typing. Turn off Auto-hide controls or press **Esc** to show controls normally.
- To watch just a video in the small floating window, click the website player’s fullscreen button. The video fills the current window without enlarging it, including embedded players that allow fullscreen. A brief notice reminds you to press Esc to exit fullscreen. Resize the window as needed and use the pin to keep it above other apps. Esc exits video fullscreen and restores the previous UI mode. Switching tabs exits the video’s fullscreen state. Opening another profile leaves the original video and page running.
- **F11** separately toggles full-screen browsing across the monitor. Auto-hide controls only changes UI visibility.
- Bookmarks show each website’s own favicon when available. Icons are cached locally; there is no third-party icon service. Missing icons are discovered from the standard favicon or the website’s HTML metadata, including relative paths and redirects. When a favicon URL returns HTML, its metadata is checked too; this finds DeepSeek's official PNG without loading its protected homepage. Gmail aliases use the canonical mail host’s public favicon. Temporary failures retry after 15 seconds and one minute; reopening the start screen can retry later. Visiting a bookmarked page updates its advertised icon even after redirects. Icons use Chromium’s image decoder and are cached as 32-pixel PNGs. Supported formats include PNG/APNG, JPEG, GIF, WebP, AVIF, BMP, ICO/CUR, SVG and SVGZ, plus inline image data URLs. Animated images use a static first frame. SVGs are decoded only as images, with scripts and external resources disabled. Incorrect MIME labels are handled when the bytes identify a supported image. Formats outside the bundled Chromium codecs (including JPEG XL, TIFF, and HEIC) and unreadable icons keep the letter fallback.
- Websites can request microphone, camera, location, notifications, clipboard reading, audio output, mouse capture, local network, local fonts, or idle detection. Choose **Allow**, **Block**, or **Not now** in the compact panel above the page. Choices are saved per site and profile. Sensitive APIs require HTTPS (or local development addresses); Windows privacy settings must also allow the relevant device. Location results depend on the available system/provider.
- The browser-drawn site icon beside the address shows a warning for ordinary HTTP sites; favicons appear on tabs only. Click the site icon to change or reset site permissions. Changes reload matching pages in that profile and stop ongoing capture. Screen sharing asks you to select a screen or window every time; system audio is optional.
- Click the star in the address bar to bookmark the current website. Click it again to remove that bookmark.
- Saved bookmarks appear on the start screen every time you open the browser. Choose **New tab page** in the menu to return there, then click a shortcut to open it. Start-page shortcuts scroll horizontally in one row. Their light green scrollbar appears on hover or keyboard focus. Right-click a shortcut or bookmark-bar entry and choose **Edit** to change its name and address. The bookmark bar below the address bar stays one row, hides when empty, and can be toggled in the menu. Drag its bookmarks to reorder.
- Use **Add shortcut** on the start screen to save an address and an optional name. Use the **×** beside a saved bookmark to remove it. Drag the dotted handle on bookmarks and profile cards to reorder them; the order stays saved. The handle also supports **Alt+↑ / Alt+↓**.
- Bookmarks are stored locally for the active profile. They stay saved when the browser closes and across installed-app updates; there is no bookmark sync.
- Click the circular profile button to see all profiles in a vertical menu over the page. The picker floats above the website without moving or resizing it. Choosing an unopened profile opens a new floating browser and leaves the original window and its tabs untouched. Choosing any already-open profile only closes the picker. Use **+ New**, or the rename/delete controls on each profile card. New profiles start with an empty welcome screen and their own data. The last profile cannot be deleted.
- In the portable version, your window settings, cookies, and browsing data stay in `.mini-browser` alongside the application. In the installed version, they stay in `%APPDATA%\Mini Browser`. Open HTTP/HTTPS tabs are saved per profile periodically and when windows close, then restored when that profile next opens. Closing the app with multiple windows saves all tabs for each profile. A profile without saved website tabs shows the welcome screen. Window Keep on top starts off; pinned and muted tab settings are restored. History is written after a short delay and flushed on exit. If a history, preferences, password, or profile registry file is corrupt, Mini Browser opens with temporary in-memory data, keeps the original file unchanged, and displays a notice.

| Shortcut | Action |
| --- | --- |
| Ctrl+L | Focus and select the address |
| Alt+Left / Alt+Right | Back / forward |
| Ctrl+R or F5 | Reload, or stop an active load |
| Ctrl+F | Find in the active page |
| Ctrl+H | History for this profile |
| Ctrl+Shift+T | Reopen the last closed tab in this profile |
| Ctrl+P | Print the active page with the system dialog |
| Enter / Shift+Enter in find | Next / previous match |
| Ctrl+Plus / Ctrl+Minus / Ctrl+0 | Zoom in / out / reset the active tab |
| Esc | Exit video fullscreen, show hidden controls / exit screen fullscreen, or stop loading |
| Ctrl+Shift+H | Toggle UI auto-hide without changing window size |
| F11 | Toggle browser fullscreen |
| Ctrl+T / Ctrl+W | New tab / close current tab |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous tab |
| Ctrl+1–8 / Ctrl+9 | Select a numbered tab / last tab |
| Ctrl+Shift+P | Toggle always on top |
| Ctrl+D | Add or remove the current page's bookmark |
| Alt+Home | Open the start screen and bookmarks |

Right-click a tab for New tab, Reload, Duplicate, Pin tab, Mute, Close, and Close others. Pinned tabs stay first and show their favicon.

Drag a tab within its strip to reorder it, outside the window to detach it into a new floating browser, or onto the tab strip of another window of the same profile to move it there. The existing page, forms, session storage, and history move with the tab. Press Esc to cancel a drag. Moving the final tab closes its empty source window; clicking × on the final tab leaves a new start page. Restored tabs reload their saved URLs; forms and session storage are not restored. Extensions, external app links, and direct USB/HID/serial device access are not supported. Some services that require a full browser, DRM, or popup-based login may not work.

To add a profile picture, open the profile picker and click that profile's initial or existing photo. Choose a PNG, JPEG, or WebP image (up to 10 MB). The browser crops it to a square and saves a small 128-pixel local copy; the original file stays unchanged. Click the small × on the photo to return to initials. Each profile keeps its own picture across restarts.

## Profiles and local data

The app stores profile names, optional picture thumbnails, stable ids, the last active id, and pending deletion cleanup in `profiles.json` in its user-data directory. The first profile is **Default**: it retains the existing `persist:pages` partition and root `bookmarks.json`, so upgrading preserves existing cookies and bookmarks. New profiles use unique `persist:profile-<id>` partitions and `profiles/<id>/bookmarks.json`.

Cookies, HTTP cache, local storage, IndexedDB, cache storage, and service workers belong to each profile's partition. Each floating window has one profile and its own tabs; only its active page is visible. Profiles can run different accounts simultaneously. Opening a profile never changes an existing window's session. Detached windows of the same profile share cookies, persistent storage, and bookmarks. Tabs cannot move between different profiles. Session storage stays with its live tab, including when detached, and is discarded when that tab closes. The last active profile reopens with its own saved tabs after restart. Saved URLs live in `tabs.json` alongside that profile's bookmarks. History and the last 25 closed tabs are stored in profile-local `history.json`; bookmark-bar preference is in `preferences.json`. The omnibox matches only local bookmarks and history, with up to eight suggestions. History keeps the most recent 5,000 distinct URLs. Size and position remain global in `window.json`. Downloaded files stay in the Downloads folder when a profile is deleted.

Deleting a profile closes all of its windows, aborts their page loads, clears its session data and authentication cache, and removes its bookmarks, saved permissions, history, passwords, preferences, and saved tabs. If it is the only open profile, another surviving profile opens before those windows close. Chromium keeps some partition database files locked until the app exits; those cleared partition files are removed on the next launch before that partition can be opened. Profile ids are never reused. Deleting Default removes its old bookmark file and partition without removing global window settings.

`MINI_BROWSER_TEST=1` uses an in-memory profile registry and the existing `test-pages` partition for Default. Additional test profiles use unique nonpersistent partitions. This mode never reads or writes `profiles.json`. A test profile UUID keeps all test files in a disposable project-local directory.

Passwords stay in that profile's passwords.json, encrypted using Windows DPAPI through Electron safeStorage. There is no plaintext fallback or password sync. On a submitted login form, a same-origin navigation or disappearance of the password form without a visible error offers **Save password?**; saving always requires your click. Some custom or multistep login forms cannot be detected reliably. The key icon in the omnibox offers saved logins only for the current origin, and filling requires your selection. Passwords in the menu lets you show, copy, or delete an entry. Showing or copying asks for an in-app confirmation; copied passwords are removed from the clipboard after 30 seconds if they are still there. Password capture/fill is limited to HTTPS and loopback development sites, runs only in the active main frame, and never submits a filled form automatically. The app never transmits saved passwords; submitting a filled form sends them to that website as usual.

**Clear browsing data** has separate History, Cached files, Cookies, and Saved passwords checkboxes. It clears only the selected profile and does not remove bookmarks or downloaded files. Pages have spellcheck enabled with en-US selected; Windows uses its system spelling services.

## Develop

Requires Node.js 22.12+ on Windows. Build dependencies, download caches, build output, and development/test application data are kept inside this project.

```powershell
$env:ELECTRON_CACHE = "$PWD\.cache\electron"
$env:electron_config_cache = $env:ELECTRON_CACHE
$env:ELECTRON_GET_USE_PROXY = '1'
$env:NODE_USE_ENV_PROXY = '1'
$env:NPM_CONFIG_USERCONFIG = "$PWD\.npmrc"
$env:NPM_CONFIG_GLOBALCONFIG = "$PWD\.npmrc-global"
$env:TEMP = "$PWD\.cache\tmp"
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force $env:TEMP | Out-Null
npm ci
npm start
```

```powershell
npm test        # Navigation, bookmark validation, and profile metadata/migration
npm run test:app # Actual Electron navigation, resizing, pinning, isolation, and screenshots
npm run build   # Portable Windows ZIP; unpacked build is temporary
npm run build:installer # Windows setup executable
npm run test:installer # Check setup payload without installing or creating shortcuts
npm run test:profiles # Simultaneous profile accounts, data isolation, restart, deletion, and live tab transfer
npm run test:tabs # Tab state, windowed video and controlled edge input
npm run test:basics # Downloads, find, isolated tab zoom, real context menus and profile tab restoration
npm run test:icons # Favicon metadata discovery, redirects, local caching and profile isolation
npm run test:formats # Real bookmark/tab decoding across web formats, safe SVGs, inline icons and caching
npm run test:compatibility # Native page hit testing, live voice/text, WebSocket/streaming, uploads and clipboard consent
npm run test:permissions # Simulated microphone/camera, consent, source picker, profile isolation, restart and favicon caching
npm run test:windows # Actual profile/bookmark drag gestures and tab detaching
npm run test:everyday # Chrome-style shell, suggestions, history, encrypted save/fill, selective clear, print and background lifecycle
```

The installer build can reuse the Electron runtime from an extracted portable copy in `dist/Mini-Browser-Windows-x64/Mini Browser-win32-x64`, or from a project-local folder supplied as an argument. Otherwise it downloads the pinned Electron runtime. It always rebuilds application code from `src` and excludes existing browsing data.

The persistent-profile test runs a disposable portable copy inside this project, without reading the installed app or its data. It tests different logins on the same site, all supported storage types, HTTP cache isolation, independent windows, live tab transfer, saved ordering, restart persistence, deletion, global bounds, and browser restrictions. Its main-process inspector driver avoids pausing service workers through a browser debugger.

The application uses Electron's WebContentsView. Remote websites run in a separate sandboxed session without Node.js or access to application controls. A sandboxed isolated preload observes password forms and accepts origin-checked fill messages; it exposes no API to page JavaScript. A separate trusted chrome view draws transient menus and find/download bubbles above the active website. Keep Electron current when rebuilding for continued use.

The page compatibility module disables native window-drag styles inside websites and their popups. Some sites share these styles with desktop applications; in Electron they can otherwise swallow hover, dropdown, sidebar and message-composer input. Only Mini Browser's trusted tab strip remains a drag region. Audio, title and favicon updates keep the native view order stable. Chromium already supplies WebRTC audio/data, MediaRecorder/Opus, WebSocket, streamed responses and native file uploads; these are tested without adding a separate voice service or changing the browser UI. The voice test uses a local peer connection and simulated microphone, not a signed-in ChatGPT account, so it does not verify ChatGPT account eligibility, service availability or its current authenticated UI.

The tab/fullscreen test uses a workspace-only test profile, a visible window, and controlled cursor input so normal mouse use does not interrupt it. Set `MINI_BROWSER_POINTER_SMOKE=1` to check real cursor movement; that mode restores the pointer afterward. The test covers playing canvas-stream video and iframe fullscreen inside a small floating window, preserved bounds and pin state, resizing during playback, edge reveal, and restoration of the previous UI mode. F11 screen fullscreen is tested separately. The active page keeps rendering when another app has focus; background tabs retain normal Chromium throttling. Fullscreen remains available to the active HTTP/HTTPS tab with Chromium’s user-gesture requirement. Common site permissions use explicit prompts and per-profile permissions.json files (Default uses the data-directory root; other profiles use profiles/<id>). Clipboard writing, persistent storage and screen wake locks are allowed for active secure pages. Unknown permissions and direct hardware access remain blocked. Screen sharing uses an explicit source picker and requires a user gesture. The shell alone owns tab controls, window buttons, and layout; remote pages receive no application bridge.

Permission tests use simulated media devices and a stubbed screen source, so they do not record your microphone, camera or desktop. Test mode keeps permission choices in memory and never reads or writes the user’s permission or profile files.
