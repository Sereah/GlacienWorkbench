# Glacien Workbench

## Architecture

Glacien is a Python standard-library HTTP backend with a static HTML/CSS/JavaScript UI. `codes/desktop_launcher.py` hosts it in PySide6 Qt WebEngine; `codes/launcher.py` remains the Chrome/Edge `--app` fallback. The service must bind only to `127.0.0.1`.

Keep domain boundaries:

- `app/storage.py`: platform user-data root, feature paths, atomic JSON writes.
- `app/config.py`: merged API view, schema validation, legacy migration, rule/command import-export.
- `app/android.py`: SDK-tool lookup and ADB execution.
- `app/artifacts.py`: APK, resource archives, signing files, safety validation.
- `app/device.py`: processes, launch, broadcasts, custom commands and Logcat filtering.
- `app/server.py`: HTTP/SSE decode, route and response only.
- `web/`: static UI and browser state.

## User data

Source and packaged runs both use the platform application-data directory:

- macOS: `~/Library/Application Support/GlacienWorkbench/`
- Windows: `%LOCALAPPDATA%\GlacienWorkbench\`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/GlacienWorkbench/`

`GLACIEN_DATA_DIR` may override it for tests. The repository `defaults.json` is a read-only initialization seed, not runtime configuration. Do not reintroduce `settings.<name>.json` or `active_settings.json`.

Feature data is isolated:

- `app.json`: port and SDK path only.
- `apk-center/config.json`, `apk-center/files/`.
- `resource-deployment/config.json`, `resource-deployment/files/`.
- `signing/config.json`, `signing/keystores/`.
- `processes/config.json`.
- `broadcasts/presets.json`.
- `live-logs/presets.json`, `live-logs/exports/`.
- `offline-logs/config.json`.
- `device-logs/sources.json`, `device-logs/pulls/`.
- `commands/commands.json`.
- `captures/`, `device-files/downloads/`, `runtime/web-profile/`.

All JSON writes must go through `storage.write()` for atomic replacement. Passwords are request-scoped and must never be persisted.

## Storage compatibility contract

- Keys in `storage.STORAGE_DOMAINS` are permanent machine-facing feature IDs. Never rename or reuse a released key because a page, menu, tab, or product label changes. UI structure and storage identity are independent.
- New independently persisted features must add a new stable storage key. Extensions of an existing feature may add fields to its existing domain with backward-compatible defaults. A field type or semantic change requires that domain's `schema_version` to increase and a sequential migration in `app/migrations.py`.
- Every persisted JSON object must keep matching `storage_key` and `schema_version` metadata. Missing metadata is legacy v1 data and may be upgraded; a mismatched key or a schema newer than the running application must be rejected without rewriting the file.
- Before rewriting an older schema, preserve the original JSON under `runtime/migration-backups/<timestamp>/`. Migrations must be deterministic, domain-local and sequential (`v1 -> v2 -> v3`). Never migrate or delete user asset directories as a side effect of a JSON schema migration.
- Use `storage.update()` for domain changes so unknown fields survive. Browser pages must save through `/api/config/domain` and update only the owning domain; do not restore aggregate `POST /api/config` writes.
- User-created entities that are shared across machines need immutable IDs separate from editable display names. Imports must merge by ID/content, preserve same-name conflicts as separate entries, and remain compatible with documented older export schemas.
- Rule sharing and full user-data backup are different concerns. Share bundles must exclude machine-local paths, SDK paths, secrets, APKs, keystores, logs and captures unless a future explicit backup workflow says otherwise. Unknown future feature keys should be skipped and reported, not allowed to corrupt known domains.

## Safety

- Never trust browser-supplied local paths. Rescan the owned feature directory and compare resolved paths.
- APKs belong only to `apk-center/files/`; resources only to `resource-deployment/files/`; keystores only to `signing/keystores/`.
- Resource deployment is destructive. Each archive has its own non-root absolute device directory. Validate archive top-level names before `rm`; use ADB argument arrays and explicit destination filenames.
- Multi-device operations must validate the browser-selected serial with `android.selected_device_settings()` and use `android.device_adb()`.
- Keep passwords, keys, logs, APKs, resources, captures, downloads and all system user-data directories out of source/update packages.
- Do not delete or bulk-modify user data unless explicitly requested.

## Code quality

- Follow SRP, short methods, meaningful names and guard clauses.
- Avoid duplicate code and magic values.
- Do not swallow exceptions.
- Make the smallest change required; avoid unrelated refactors.
- Use Chinese comments for non-obvious destructive, security, ADB and async/SSE behavior.
- Build subprocess commands as argument arrays; never interpolate browser input into a host shell command.

## Checks

Run from repository root:

```bash
PYTHONPYCACHEPREFIX=/private/tmp/glacien_pycache \
  python3 -m py_compile codes/launcher.py codes/desktop_launcher.py \
  codes/app/*.py codes/build_desktop.py codes/package_launcher.py

node --check codes/web/app.js
python3 -m json.tool defaults.json
python3 -m unittest discover -s tests -v
```

Desktop builds are platform-local:

- macOS: `增量构建 Glacien macOS.command` / `全量构建 Glacien macOS.command`
- Windows: `增量构建 Glacien Windows.bat` / `全量构建 Glacien Windows.bat`
- Linux: `增量构建 Glacien Linux.sh` / `全量构建 Glacien Linux.sh`

Do not build desktop artifacts unless requested.
Desktop build scripts only generate the platform application under `dist/`; they do not create distribution archives automatically. `release-output/` is generated output and must not enter source or update packages.

## Documentation

Read `codes/AGENT_GUIDE.md`, then the relevant file in `codes/docs/`. Before changing any persisted field, page ownership, import/export format, or feature storage, read `codes/docs/storage-contract.md`. Update `defaults.json`, README and the domain document when a persisted field or user-visible workflow changes.
