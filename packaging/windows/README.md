# AllosWorstation / DescribePrint — Windows power + program pack

Portable **zip + Start**, not Electron/Tauri. Next.js still runs via `npm run dev` through the existing one-click scripts.

This pack **reuses**:

- `Start-DescribePrint.cmd` → `scripts/windows/Start-DescribePrint.ps1`
- `npm run health:preflight`
- `vendor/openscad` + `OPENSCAD_PATH` + `resolveOpenscad` in `lib/openscad.ts`

Desktop launchers **must** `call` the repo `Start-DescribePrint.cmd`. Do not inline `npm run dev` in the bat.

## What ships

A **setup pack** (sources + scripts). `node_modules` and the OpenSCAD binary are **not** committed (size + OpenSCAD’s own license). Setup downloads OpenSCAD into `vendor/openscad` and runs `npm install`.

| Output | How |
| --- | --- |
| `dist/AllosWorstation-portable/` | `npm run pack:windows` or `scripts/windows/Build-Portable.ps1` |
| `dist/AllosWorstation-portable.zip` | same (omit `--skip-zip`) |
| Optional `.exe` installer | `npm run pack:windows:installer` or `scripts/windows/Build-InnoInstaller.ps1` (needs Inno Setup 6) |
| MSI | **Follow-up** — not in this slice |

## Machine layouts (do not break)

| Layout | Role | Repo path | OpenSCAD | How Start finds it |
| --- | --- | --- | --- | --- |
| **Smith** | **24/7 AllosWorstation host** (desktop, not the laptop). Auto-start + AC sleep-never default ON. Install Tailscale here (same account as the iPhone). | Often OneDrive Desktop `AllosWorstation\DescribePrint` | Portable `vendor\openscad` is fine | `%~dp0DescribePrint` (sibling of the Desktop bat) |
| **Laptop** | Portable checkout. **Not** the always-on remote host. Auto-start off unless `-AutoStart`. Do not apply host power. Laptop Tailscale alone is not enough for away-from-home. | Prefer `C:\Users\clove\AllosWorstation\DescribePrint` **outside OneDrive** | Program Files OpenSCAD is OK | Absolute `cd /d %USERPROFILE%\AllosWorstation\DescribePrint` |

Defaults:

- Smith / Current: stay in the folder you ran setup from (if it already is DescribePrint).
- Laptop: `%USERPROFILE%\AllosWorstation\DescribePrint` (for `clove` that is `C:\Users\clove\AllosWorstation\DescribePrint`).
- **Smith = 24/7 host.** `Install-AllosWorstation.ps1 -Layout Smith` registers logon auto-start and AC sleep-never. Laptop does not.

Override with `-RepoPath` / `--repo-path`.

## OneDrive Desktop Start bat (Smith + laptop)

`Desktop\AllosWorstation\Start DescribePrint.bat` lives under OneDrive and **syncs between Smith and laptop**. One bat cannot assume a single machine path.

**Do not** write a Smith-only `%~dp0DescribePrint` bat or a laptop-only absolute path and expect it to work on both synced Desktops. Running `Install -Layout Smith` on a synced Desktop used to overwrite the laptop bat (and vice versa).

Install always writes the **same** detector bat (safe to overwrite via OneDrive) plus a **machine-local** hint that OneDrive does not sync:

1. `%LOCALAPPDATA%\AllosWorstation\repo-path.txt` — written by `Install -Layout …` for **this** PC (Laptop → `%USERPROFILE%\AllosWorstation\DescribePrint`, Smith → the Smith checkout).
2. Hostname hint: `%COMPUTERNAME%` vs `ALLOS_LAPTOP_HOST` / `ALLOS_SMITH_HOST`, or `ALLOS_LAYOUT=Laptop|Smith`.
3. Laptop path exists: `cd /d %USERPROFILE%\AllosWorstation\DescribePrint` then `call` that tree’s `Start-DescribePrint.cmd`.
4. Smith path exists: `call %~dp0DescribePrint\Start-DescribePrint.cmd`.

Optional hostname pin (when both copies exist on one PC):

```bat
setx ALLOS_LAPTOP_HOST "YOUR-LAPTOP-HOSTNAME"
setx ALLOS_SMITH_HOST "YOUR-SMITH-HOSTNAME"
```

PowerShell wrappers in `scripts/windows/*.ps1` are **UTF-8 with BOM** and ASCII-only so Windows PowerShell 5.1 can parse them. Do not put Windows paths inside double-quoted strings (a UTF-8 em dash or `\"` will throw `The string is missing the terminator: "`).

## Build the pack

From a git checkout (any OS with Node 22+):

```bat
npm run pack:windows
```

Windows:

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\Build-Portable.ps1
```

Include a portable OpenSCAD binary **inside the zip** (optional, ~22 MB, not committed):

```bat
npm run pack:windows -- --fetch-openscad
```

Folder-only (no zip):

```bat
npm run pack:windows -- --skip-zip
```

## Install / first-run setup

### From a zip

1. Unzip `AllosWorstation-portable.zip`.
2. Install [Node.js LTS](https://nodejs.org) if `node` is missing.
3. Double-click `Setup-DescribePrint.cmd`  
   or:

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\Install-AllosWorstation.ps1 -Layout Laptop
```

Smith (24/7 host; keep OneDrive checkout; auto-start + host power default ON):

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\Install-AllosWorstation.ps1 -Layout Smith
```

Smith one-liners (if you already installed the tree):

```bat
npm run autostart:windows
npm run host-power:windows
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\Install-AutoStart.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\Uninstall-AutoStart.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\Configure-HostPower.ps1 -Layout Smith
```

Laptop auto-start is **opt-in only** (`-AutoStart`). `-RemoveAutoStart` uninstalls the task and Startup shortcut. `-NoAutoStart` / `-SkipHostPower` skip the Smith defaults. `Configure-HostPower.ps1` no-ops unless `-Layout Smith` or `-ForceHost` (does not brick laptop battery settings).

Setup will:

1. Copy the tree to the laptop path when `-Layout Laptop` and the source is elsewhere.
2. Write/merge `.env.local` (local Ollama defaults; **never** `MODEL=smith-minicpm5`).
3. Fetch OpenSCAD into `vendor\openscad` unless Program Files OpenSCAD is present (`-Layout Laptop` prefers the system install).
4. Run `npm install` when `node_modules` is missing.
5. Write the shared `Desktop\AllosWorstation\Start DescribePrint.bat` detector and `%LOCALAPPDATA%\AllosWorstation\repo-path.txt` for this layout.
6. Run `npm run health:preflight` (soft — Ollama can be started later).
7. **Smith only (default):** register logon auto-start (`Install-AutoStart.ps1`, Task Scheduler AtLogOn → `Start-DescribePrint.cmd`) and set AC sleep/hibernate timeout to never (`Configure-HostPower.ps1`). User-session logon is enough; a true “run whether user is logged on” service is not used because Next.js + the LAN/Tailscale QR need a session.

### From this git clone

Same scripts. You do not need the zip.

```bat
npm run setup:windows
```

## Start

One click:

- `Start-DescribePrint.cmd` in the repo / unpacked folder
- or Desktop `\AllosWorstation\Start DescribePrint.bat` (OneDrive-safe detector; calls that cmd)
- or `npm run start:windows`

The Start script copies `.env.local` if needed, `npm install`s on first launch, prints the **LAN URL + QR** (optional Tailscale `100.x` preferred when present), and runs `npm run dev` on **`0.0.0.0:3000`**. This PC still opens [http://localhost:3000](http://localhost:3000). An iPhone on the same Wi‑Fi uses `http://<lan-ip>:3000` (Add to Home Screen / PWA). Allow Node on **Private** networks; do not port-forward. Ollama stays `127.0.0.1:11434`. See the main README iPhone / Tailscale sections.

**Away-from-home:** install Tailscale on **Smith** (the 24/7 host) and the iPhone, same account. Laptop Tailscale alone is not enough — the phone must reach Smith, not a closed laptop.

## Health

```bat
npm run health:preflight
```

Probes Ollama on `127.0.0.1:11434`, the configured `MODEL`, and OpenSCAD (`vendor/openscad`, Program Files, or `OPENSCAD_PATH`). This is the same check Start runs (`lib/health-preflight.ts` via `scripts/windows/health-preflight.ts`).

- Exit `0` — PASS (Local AI + OpenSCAD look ready).
- Exit `2` — soft WARN/FAIL (Ollama down, MODEL missing, OpenSCAD missing). **Start still continues.**
- Exit `1` — runner crash only. Start still continues.

Setup also runs `scripts/health-preflight.mjs` as a pack gate: it **refuses** an Agent Smith `MODEL` in `.env.local` (`--skip-network` checks files/env only). `ensure-env-local` rewrites a Smith `MODEL` key to qwen; Ollama’s installed Smith weights stay put.

The in-app header chip and `GET /api/health` show the same idea after Start.

## OpenSCAD

Resolution order is unchanged (`lib/openscad.ts`):

1. `OPENSCAD_PATH`
2. `OPENSCAD_BIN`
3. `vendor/openscad/openscad.exe` (this pack’s drop-in)
4. Program Files / scoop / Chocolatey
5. `PATH`

Fetch without the full installer:

```bat
npm run openscad:portable
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\Install-OpenSCAD-Portable.ps1
```

Default URL (official stable 64-bit zip, downloaded at pack/setup time — **not** stored in git):

`https://files.openscad.org/OpenSCAD-2021.01-x86-64.zip`

Override: `$env:OPENSCAD_PORTABLE_URL` or `--url`. Laptop may use [openscad.org](https://openscad.org/) / `winget install --id=OpenSCAD.OpenSCAD -e` instead.

## Ollama — qwen only

DescribePrint talks to **local** Ollama only:

| Setting | Value |
| --- | --- |
| Host | `127.0.0.1:11434` |
| `OPENAI_BASE_URL` | `http://127.0.0.1:11434/v1` |
| `MODEL` (default) | `qwen2.5-coder:32b` |
| Lighter overrides | `qwen2.5-coder:14b` or `qwen2.5-coder:7b` in `.env.local` |

Pull **DescribePrint’s** models alongside whatever is already installed:

```bat
ollama pull qwen2.5-coder:32b
```

Lighter machines (~less than 32GB RAM):

```bat
ollama pull qwen2.5-coder:14b
REM then set MODEL=qwen2.5-coder:14b in .env.local
```

```bat
ollama pull qwen2.5-coder:7b
```

No cloud API key is required.

## Agent Smith model safety

Ollama on these machines may already serve **Agent Smith**. DescribePrint **shares that server** and must not interfere.

- **Do not** change Ollama’s port, host, or global config.
- **Do not** delete, replace, retarget, or document replacing Smith models (`smith-minicpm5`, `openbmb/minicpm5-*`, anything matching `minicpm5`).
- **Do not** run `ollama rm` against those models.
- Isolation is a **dedicated model name**: `qwen2.5-coder:*` only.
- The pack **refuses** to write a Smith name into `MODEL`. If `.env.local` already has one, setup rewrites **only that env key** to qwen. Ollama’s installed Smith weights stay put.
- This pack does **not** embed Agent Smith code.
- **Contention:** if heavy DescribePrint generation and Agent Smith would both hammer GPU/RAM, the user chooses. Prefer the DescribePrint host always available (auto-start Next on Smith). Do **not** auto-kill Smith models or change Ollama.

## Optional Inno Setup

Portable zip remains the **supported** path. Setup.exe is optional (no Node bundled; **MSI is out of scope**).

```bat
npm run pack:windows:installer
```

or:

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\Build-InnoInstaller.ps1
```

The helper:

1. Ensures `dist\AllosWorstation-portable\` exists (`npm run pack:windows -- --skip-zip` if missing).
2. Locates Inno Setup 6 `ISCC.exe` (Program Files, `%LOCALAPPDATA%\Programs`, or PATH).
3. Compiles `packaging/windows/AllosWorstation.iss`.
4. Prints `dist/AllosWorstation-DescribePrint-Setup.exe`.

If `ISCC.exe` is missing it fails with a link to [jrsoftware.org](https://jrsoftware.org/isinfo.php). The `.iss` also `#error`s at compile time when the portable `Start-DescribePrint.cmd` is absent.

The installer keeps `PrivilegesRequired=lowest`, writes the shared OneDrive-safe Desktop detector bat (no machine-specific `{app}` path in that bat), and records `%LOCALAPPDATA%\AllosWorstation\repo-path.txt`. Start Menu always gets **Start DescribePrint** → `Start-DescribePrint.cmd`; a Desktop shortcut to the same cmd is optional. The finished-page tip covers Node LTS, `ollama pull qwen2.5-coder:32b` (or 14b/7b), Agent Smith model safety, and Ollama port **11434**.

## Scripts map

| Script | Role |
| --- | --- |
| `scripts/build-portable.mjs` | Create `dist/AllosWorstation-portable` + zip |
| `scripts/install-allos.mjs` | Layouts, copy, env, OpenSCAD, npm, Desktop bat, health |
| `scripts/ensure-env-local.mjs` | Merge `.env.local` (qwen / 11434) |
| `scripts/windows/health-preflight.ts` + `lib/health-preflight.ts` | `npm run health:preflight` (Start) |
| `scripts/health-preflight.mjs` | Pack/setup Smith-model gate |
| `scripts/install-openscad-portable.mjs` | Download official zip → `vendor/openscad` |
| `scripts/windows/Build-InnoInstaller.ps1` | Optional Setup.exe (`npm run pack:windows:installer`) |
| `scripts/windows/*.ps1` | Windows wrappers (same behavior) |
| `scripts/windows/Install-AutoStart.ps1` | Logon auto-start (Task default, or Startup shortcut). `npm run autostart:windows` |
| `scripts/windows/Uninstall-AutoStart.ps1` | Remove task + Startup shortcut. `npm run autostart:windows:remove` / `-RemoveAutoStart` |
| `scripts/windows/Configure-HostPower.ps1` | Smith-only AC sleep-never. Refuses without `-Layout Smith` / `-ForceHost`. `npm run host-power:windows` |
| `Setup-DescribePrint.cmd` | First-run entry (portable zip + clone) |
| `Start-DescribePrint.cmd` | One-click app start (unchanged contract; still prints LAN/Tailscale QR) |
