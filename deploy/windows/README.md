# Deploying MPanel on Windows

The worker runs natively on Windows (ConPTY via `node-pty`, optional). core can
run natively or on Linux.

## NSSM service (worker)

```powershell
nssm install MPanelWorker "C:\Program Files\nodejs\node.exe" "dist\index.js"
nssm set MPanelWorker AppDirectory "C:\mpanel\worker"
nssm set MPanelWorker AppEnvironmentExtra `
  MPANEL_HOME="C:\ProgramData\mpanel\worker" `
  MPANEL_TOKEN="<generated>" `
  MPANEL_TRANSPORT=http `
  MPANEL_PORT=8787
nssm set MPanelWorker AppStdout "C:\ProgramData\mpanel\worker\logs\stdout.log"
nssm set MPanelWorker AppStderr "C:\ProgramData\mpanel\worker\logs\stderr.log"
nssm start MPanelWorker
```

Use the `pnpm deploy` output directory as `AppDirectory` so `@mpanel/shared`
and `zod` resolve from its own `node_modules`.

## Environment variables

Set machine-wide variables with `setx` or `[Environment]::SetEnvironmentVariable`.
Prefer a dedicated service account; avoid putting secrets in plain-text scripts.

## Scheduled tasks

Tasks run through PowerShell/cmd (`buildShellArgs`) and kill the whole process
tree on timeout via `taskkill /T /F`. Terminal sessions need ConPTY; when
`node-pty` is unavailable the worker falls back to a pipe session (`pty=false`).

## Paths

- Backslashes are rejected in file API virtual paths; use POSIX `/` inside a root.
- Caddy roots and task/terminal cwd use host paths (drive letters allowed).
- Directory replacement is not atomic on NTFS; site apply keeps a rollback copy.
- Grant the service account only the file roots, Caddy dirs and Docker access it
  needs.
