# Electron Desktop App — Architecture

## Цель

Standalone desktop-приложение OKO NVR для Windows/Linux/macOS.
Один .exe/.AppImage/.dmg — скачал, запустил, добавил NVR через wizard, работает.
Docker-версия сохраняется параллельно.

---

## 1. Итоговая структура проекта

```
okonvr/
├── backend/              ← БЕЗ ИЗМЕНЕНИЙ (shared)
│   ├── src/
│   └── package.json
├── web/                  ← БЕЗ ИЗМЕНЕНИЙ (shared)
│   ├── js/
│   ├── css/
│   └── index.html
├── electron/             ← НОВОЕ
│   ├── main.ts           — Electron main process entry
│   ├── preload.ts        — Context bridge (IPC для wizard)
│   ├── go2rtc.ts         — go2rtc lifecycle manager
│   ├── server.ts         — Embedded Fastify + static + proxy
│   ├── paths.ts          — Cross-platform path resolver
│   ├── wizard/           — Setup wizard (отдельный HTML)
│   │   ├── wizard.html
│   │   ├── wizard.css
│   │   └── wizard.js
│   ├── icons/            — App icons (ico, icns, png)
│   ├── package.json      — Electron-specific deps
│   ├── tsconfig.json
│   └── forge.config.ts   — electron-forge build config
├── go2rtc-bin/           ← Bundled binaries (gitignored, downloaded at build)
│   ├── go2rtc-win-amd64.exe
│   ├── go2rtc-linux-amd64
│   ├── go2rtc-linux-arm64
│   └── go2rtc-darwin-arm64
├── docker-compose.yml    ← Docker path (unchanged)
├── nginx/                ← Docker only
├── oko.yaml              ← Config (Docker uses /config/, Electron uses userData)
└── scripts/
    └── download-go2rtc.sh  — Fetches go2rtc binaries from GitHub releases
```

---

## 2. Что меняется, что нет

### Не меняется (shared code)
- `backend/src/**` — весь TypeScript backend
- `web/**` — весь фронтенд
- `oko.yaml` формат — тот же конфиг для обеих версий

### Минимальные изменения в backend
1. **config.ts** — добавить путь `app.getPath('userData')/oko.yaml` в CONFIG_PATHS
2. **db.ts** — DATA_DIR уже параметризован через env, ничего менять не нужно
3. **go2rtc-config.ts** — GO2RTC_CONFIG_PATH уже через env
4. **index.ts** — экспортировать `main()` как функцию (сейчас вызывается сразу)

### Новый код (electron/)
- `main.ts` — 150-200 строк, lifecycle
- `go2rtc.ts` — 100-150 строк, child_process management
- `server.ts` — 80-100 строк, Fastify + static + proxy
- `paths.ts` — 40-50 строк, platform-aware paths
- `wizard/` — ~300 строк HTML/CSS/JS

---

## 3. Архитектура runtime

```
┌─────────────────────────────────────────────────────────┐
│  Electron Main Process (Node.js)                        │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  Fastify      │  │  go2rtc      │  │  Lifecycle   │  │
│  │  :3000        │  │  :1984       │  │  Manager     │  │
│  │              │  │  (child_proc) │  │              │  │
│  │  /backend/*  │  │  WebRTC :8555 │  │  start/stop  │  │
│  │  /api/* proxy│  │              │  │  crash detect │  │
│  │  /* static   │  │              │  │  config gen   │  │
│  └──────┬───────┘  └──────────────┘  └──────────────┘  │
│         │                                               │
│  ┌──────┴───────────────────────────────────────────┐   │
│  │  BrowserWindow                                    │   │
│  │  loads http://localhost:3000                       │   │
│  │  (same web/ frontend, zero changes)               │   │
│  └───────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### Почему localhost:3000 а не file:// protocol
- WebRTC signaling (`/api/webrtc`) требует HTTP origin
- MSE WebSocket (`ws://host/api/ws`) требует origin
- fetch() к `/backend/*` — relative URLs в фронтенде
- Никаких изменений в web/ коде

### Proxy layer (заменяет nginx)
Fastify берёт на себя все роли nginx:
- `GET /*` → static files из `web/` (express-static / @fastify/static)
- `ALL /api/*` → proxy к go2rtc:1984 (http-proxy / @fastify/http-proxy)
- `ALL /backend/*` → свои routes (уже есть)
- WebSocket upgrade для `/api/ws` (MSE) — proxy с upgrade support

---

## 4. go2rtc Lifecycle

### Binary resolution
```typescript
// paths.ts
function getGo2rtcBinary(): string {
  const platform = process.platform;  // win32, linux, darwin
  const arch = process.arch;          // x64, arm64
  
  const names: Record<string, string> = {
    'win32-x64':   'go2rtc-win-amd64.exe',
    'linux-x64':   'go2rtc-linux-amd64',
    'linux-arm64': 'go2rtc-linux-arm64',
    'darwin-arm64': 'go2rtc-darwin-arm64',
    'darwin-x64':  'go2rtc-darwin-amd64',
  };
  
  const name = names[`${platform}-${arch}`];
  // In dev: ./go2rtc-bin/{name}
  // In packaged: process.resourcesPath/go2rtc-bin/{name}
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'go2rtc-bin')
    : path.join(__dirname, '..', 'go2rtc-bin');
  
  return path.join(base, name);
}
```

### Startup sequence
```
1. main.ts: app.whenReady()
2. Check first-run → show wizard OR load existing oko.yaml
3. Set env vars: DATA_DIR, GO2RTC_CONFIG_PATH, OKO_CONFIG
4. Import and run backend main() → generates go2rtc.yaml
5. go2rtc.ts: spawn go2rtc binary with generated config
6. Wait for go2rtc health (poll /api/streams, max 10s)
7. Create BrowserWindow → load http://localhost:3000
```

### Crash recovery
```typescript
// go2rtc.ts
class Go2rtcManager {
  private proc: ChildProcess | null = null;
  private restartCount = 0;
  private maxRestarts = 5;
  private restartDelay = 2000; // doubles each restart, cap at 30s
  
  start(configPath: string): void {
    const bin = getGo2rtcBinary();
    this.proc = spawn(bin, ['-config', configPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    
    this.proc.on('exit', (code) => {
      if (this.restartCount < this.maxRestarts) {
        setTimeout(() => this.start(configPath), this.restartDelay);
        this.restartDelay = Math.min(this.restartDelay * 2, 30000);
        this.restartCount++;
      }
    });
    
    // Pipe go2rtc logs to electron console
    this.proc.stdout?.on('data', (d) => console.log(`[go2rtc] ${d}`));
    this.proc.stderr?.on('data', (d) => console.error(`[go2rtc] ${d}`));
  }
  
  async stop(): Promise<void> {
    if (!this.proc) return;
    this.proc.kill('SIGTERM');
    // Wait max 5s, then SIGKILL
    await Promise.race([
      new Promise(r => this.proc!.on('exit', r)),
      new Promise(r => setTimeout(r, 5000)),
    ]);
    if (!this.proc.killed) this.proc.kill('SIGKILL');
  }
}
```

---

## 5. Setup Wizard

### Когда показывается
- Нет `oko.yaml` в userData → первый запуск
- Пользователь выбрал "Settings → Add NVR" в меню

### Flow
```
Step 1: Welcome
  "OKO NVR needs at least one NVR to connect to."
  [Add NVR]

Step 2: NVR Connection
  Provider: [Hikvision ▼] [Dahua ▼] [Generic ▼]
  Host/IP:  [192.168.0.2    ]
  Port:     [554             ]  (pre-filled per provider)
  Username: [admin           ]
  Password: [********        ]
  [Test Connection]        ← backend вызывает provider.discoverChannels()

Step 3: Camera Selection
  "Found 32 cameras on DS-7732NI-K4"
  ☑ D1  — Camera 01 (entrance)
  ☑ D2  — Camera 02 (parking)
  ☐ D32 — Camera 32 (disabled)
  [Select All] [Deselect All]

Step 4: Done
  "Configuration saved. Starting streams..."
  → Генерируется oko.yaml
  → Backend перечитывает конфиг
  → Redirect на main window
```

### Реализация
- Отдельный BrowserWindow (500×600, no frame, center)
- Общается с backend через IPC (preload.ts → contextBridge)
- IPC handlers: `test-nvr`, `discover-cameras`, `save-config`
- Backend получает данные, формирует oko.yaml, записывает в userData
- Альтернатива: wizard как route в Fastify (`/setup`) — проще, не нужен IPC

**Решение: wizard как Fastify route** — меньше кода, тот же UX.
Backend отдаёт `/setup` HTML, wizard делает fetch к `/backend/setup/*` endpoints.
Main window показывает /setup если нет oko.yaml, иначе / .

---

## 6. Изменения в backend для dual-mode

### config.ts — расширение путей
```typescript
const CONFIG_PATHS = [
  process.env.OKO_CONFIG || '',
  // Electron userData (set by main.ts before import)
  process.env.OKO_USER_DATA ? path.join(process.env.OKO_USER_DATA, 'oko.yaml') : '',
  // Docker paths
  '/config/oko.yaml',
  '/config/oko.yml',
  // CWD fallback
  path.join(process.cwd(), 'oko.yaml'),
];
```

### index.ts — экспорт main()
```typescript
// Вместо:
main().catch(err => { process.exit(1); });

// Делаем:
export { main };

// Docker mode: запускается напрямую через node
if (!process.env.ELECTRON_MODE) {
  main().catch(err => { process.exit(1); });
}
```

### Новые setup routes (для wizard)
```typescript
// routes/setup.ts
fastify.post('/setup/test-nvr', async (req) => {
  // Принимает {provider, host, username, password}
  // Создаёт временный provider, пробует discoverChannels()
  // Возвращает {ok, cameras: [...], error?}
});

fastify.post('/setup/save-config', async (req) => {
  // Принимает полный конфиг wizard
  // Генерирует oko.yaml, записывает в userData
  // Перезагружает backend config
});
```

---

## 7. Electron Forge / Build

### package.json (electron/)
```json
{
  "name": "oko-nvr",
  "version": "0.4.0",
  "main": "dist/main.js",
  "scripts": {
    "dev": "electron-forge start",
    "build": "electron-forge make",
    "package": "electron-forge package"
  },
  "dependencies": {
    "electron-squirrel-startup": "^1.0.0"
  },
  "devDependencies": {
    "@electron-forge/cli": "^7.0.0",
    "@electron-forge/maker-squirrel": "^7.0.0",
    "@electron-forge/maker-deb": "^7.0.0",
    "@electron-forge/maker-dmg": "^7.0.0",
    "electron": "^33.0.0",
    "typescript": "^5.4.0"
  }
}
```

### forge.config.ts
```typescript
{
  packagerConfig: {
    name: 'OKO NVR',
    executableName: 'oko-nvr',
    icon: './electron/icons/icon',
    extraResource: [
      './go2rtc-bin',       // go2rtc binaries
    ],
    // Backend is compiled and included as regular node module
    asar: true,
  },
  makers: [
    { name: '@electron-forge/maker-squirrel', config: { name: 'oko-nvr' } },  // Windows
    { name: '@electron-forge/maker-deb', config: {} },                          // Linux .deb
    { name: '@electron-forge/maker-dmg', config: {} },                          // macOS
  ],
}
```

### Build pipeline
```bash
# 1. Download go2rtc binaries
./scripts/download-go2rtc.sh

# 2. Compile backend TypeScript
cd backend && npm run build

# 3. Package Electron
cd electron && npm run build
# → out/oko-nvr-win32-x64/  (Windows)
# → out/oko-nvr-linux-x64/  (Linux)
# → out/oko-nvr-darwin-arm64/ (macOS)
```

### Estimated bundle size
- Electron: ~180MB (Chromium + Node.js)
- go2rtc binary: ~15MB
- Backend compiled: ~2MB
- Frontend: ~500KB
- **Total: ~200MB** (comparable to VS Code, Slack, Discord)

---

## 8. Platform-specific notes

### Windows
- go2rtc.exe — no chmod needed
- Firewall prompt for UDP 8555 (WebRTC) — show note in wizard
- AppData/Roaming/oko-nvr/ for config and DB
- Squirrel installer (auto-update ready)

### Linux
- chmod +x go2rtc binary on first run
- ~/.config/oko-nvr/ for config
- UDP 8555 — usually no firewall issue
- .deb and AppImage targets

### macOS
- go2rtc-darwin-arm64 (Apple Silicon native)
- ~/Library/Application Support/oko-nvr/
- Code signing required for distribution (Apple notarization)
- Camera/mic permissions for talkback (entitlements.plist)

---

## 9. Plan реализации (порядок)

### Phase 1: Skeleton (1 сессия)
- [ ] Создать electron/ directory structure
- [ ] main.ts: app lifecycle, BrowserWindow
- [ ] paths.ts: cross-platform path resolution
- [ ] server.ts: Fastify static + proxy (заменить nginx)
- [ ] Минимальная интеграция: запуск backend + открытие окна

### Phase 2: go2rtc integration (1 сессия)
- [ ] go2rtc.ts: spawn, health check, restart, cleanup
- [ ] scripts/download-go2rtc.sh
- [ ] Тест: полный стек без Docker

### Phase 3: Backend adaptations (1 сессия)
- [ ] config.ts: Electron paths
- [ ] index.ts: export main(), ELECTRON_MODE guard
- [ ] go2rtc-config.ts: dynamic config path
- [ ] db.ts: userData path

### Phase 4: Setup Wizard (1-2 сессии)
- [ ] routes/setup.ts: test-nvr, discover, save-config
- [ ] wizard HTML/CSS/JS
- [ ] First-run detection + redirect

### Phase 5: Build & Package (1 сессия)
- [ ] electron-forge config
- [ ] Platform-specific makers (Windows, Linux, macOS)
- [ ] download-go2rtc script for all platforms
- [ ] Test installers

### Phase 6: Polish (1 сессия)
- [ ] App icon
- [ ] About dialog
- [ ] Menu bar (Settings, View, Help)
- [ ] Window state persistence (size, position)
- [ ] Auto-update check (GitHub releases)

**Итого: ~6-8 сессий до release-ready.**
