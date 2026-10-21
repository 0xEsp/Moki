# Deploying Moki to a Raspberry Pi (build on the Mac → copy → activate on the Pi)

The image is built on the Mac (fast) for `linux/arm64`, copied via `scp` to the Moki folder on
the Raspberry Pi and activated there after backing up the data. The Pi compiles nothing, and the
repository contains no hosts or secrets.

```
Mac                                         Raspberry Pi (<MOKI_DEPLOY_DIR>)
scripts/deploy/deploy.sh                    ├─ .env                 ← config + token (only here)
 ├─ typecheck + tests                       ├─ docker-compose.yml / docker-compose.pi.yml
 ├─ build-image.sh → releases/*.tar.gz ───► ├─ releases/moki-pi-*.tar.gz   (last 3)
 └─ ssh → remote-update.sh ───────────────► ├─ releases/moki-data-*.tar.gz (backups, last 5)
                                            └─ data/                ← your files (persistent)
```

## Initial setup (once)

1. **Key-based ssh access** from the Mac to the Pi (no password). Check it with
   `ssh user@host true`.
2. **Local target**: copy `deploy.local.env.example` to `deploy.local.env` (ignored by git) and
   fill in `MOKI_DEPLOY_SSH`, `MOKI_DEPLOY_DIR`, `MOKI_DEPLOY_URL` and, if you connect through
   several names (IP, hostname, VPN), `MOKI_ALLOWED_HOSTS`.
3. **Secrets**:

   ```bash
   bash scripts/deploy/setup-secrets.sh
   ```

   Generates a random `MOKI_TOKEN`, stores it in the **macOS Keychain** (service `moki`, account =
   `MOKI_DEPLOY_SSH`) and writes the Pi's configuration (`<MOKI_DEPLOY_DIR>/.env`, mode 600) over
   ssh. The token is never printed. `--force` rewrites the configuration; `--rotate` changes the
   token (you then need to register the MCP again).

## Deploying (every time)

```bash
bash scripts/deploy/deploy.sh
```

Runs typecheck and tests (`SKIP_CHECKS=1` to skip them), builds the image, copies it, stops the
container, saves `data/` (without `exports/`) to `releases/moki-data-*.tar.gz`, loads the image,
recreates the container and checks that it responds. If activation fails, it starts the previous
container again. Your designs (`data/`) are never overwritten.

## Connecting Claude Code and the browser

```bash
bash scripts/deploy/claude-mcp-add.sh          # add --scope user for all projects
```

Registers the MCP with the token from the Keychain. For the editor, open `MOKI_DEPLOY_URL` in the
browser and log in with the token (`security find-generic-password -s moki -a <MOKI_DEPLOY_SSH> -w`
prints it in the terminal; or `-w | pbcopy` to copy it).

## Restoring a data backup

On the Pi, inside `<MOKI_DEPLOY_DIR>`:

```bash
docker compose -f docker-compose.yml -f docker-compose.pi.yml stop moki
mv data data.old && tar -xzf releases/moki-data-YYYYMMDD-HHMMSS.tar.gz
docker compose -f docker-compose.yml -f docker-compose.pi.yml up -d moki
```

## Notes

- On Raspberry Pi OS, Docker's memory limit (`mem_limit`) only applies if the kernel has memory
  cgroups enabled (`cgroup_enable=memory cgroup_memory=1` in `/boot/firmware/cmdline.txt`, then
  reboot). Without that, Moki relies on its own low-memory profile (`MOKI_LOW_MEMORY=1`: at most
  2 Chromium runtimes, idle shutdowns).
- To connect from outside your home network, use your VPN (WireGuard, Tailscale…) and add its
  name/IP to `MOKI_ALLOWED_HOSTS` (then run `setup-secrets.sh --force`).
