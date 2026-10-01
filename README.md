<<<<<<< HEAD
# PSS Nexus Chat — Desktop (Electron)

Windows desktop client for the PSS Nexus chat web app (Slack-style wrapper).

## Requirements

- Node.js 20+
- Windows 10/11

## Setup

```bash
cd c:\projects\desktop-chat-app
npm install
cp .env.example .env   # optional — edit APP_URL if needed
```

## Troubleshooting

**`Electron failed to install correctly`**

The Electron binary download sometimes fails on first install. Run:

```bash
node node_modules/electron/install.js
npm start
```

Or reinstall:

```bash
rmdir /s /q node_modules\electron
npm install electron --save-dev
```

## Run (development)

```bash
npm start
```

Loads `APP_URL` from `.env` (default: production Vercel URL).

To test against local web app:

```env
APP_URL=http://localhost:3000
```

Then run `npm run dev` in `chat-system` and `npm start` here.

## Build Windows installer

```bash
npm run build
```

Output: `dist/PSS Nexus Chat Setup 1.1.0.exe`

Portable exe (no installer):

```bash
npm run build:portable
```

## Icons

Branded icons are in `assets/` (`icon.png`, `tray.png`). Rebuild after replacing them:

```bash
npm run build
```

## Features

- Loads hosted chat app in native window
- System tray (close hides to tray; Quit from tray menu)
- Single instance (second launch focuses existing window)
- External links open in default browser
- Taskbar badge when page title includes unread count `(3)`
- Auto-update from GitHub releases (after this version is installed once)

## Project layout

```
desktop-chat-app/     ← this repo (Electron shell only)
chat-system/          ← Next.js web app (separate project)
```
