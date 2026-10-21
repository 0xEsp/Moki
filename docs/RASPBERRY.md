# Moki on a Raspberry Pi 4B (4 GB)

Moki runs on the Pi inside Docker and you use it from the Mac: the editor in the browser and the
MCP from Claude Code, over the local network. Since it is exposed to the LAN, **access requires a
token** (`MOKI_TOKEN`).

## 1. Requirements

- **64-bit Raspberry Pi OS** (Bookworm). The image is `linux/arm64`; it does not work on the
  32-bit OS. Check it with `uname -m` → it must say `aarch64`.
- 4 GB of RAM (Pi 4B or Pi 5). Recommended: **1–2 GB of swap** (see §7).
- ~3 GB free on the card/SSD (~1.6 GB image + data). A USB 3 SSD is better than the microSD.
- Docker:

```bash
curl -fsSL https://get.docker.com | sh
```

```bash
sudo usermod -aG docker $USER
```

Log out and back in for the `docker` group to take effect.

## 2. Copying Moki to the Pi

From the Mac, inside the Moki folder (without `node_modules`, `data`, `dist` or `releases`, which aren't needed):

```bash
rsync -av --exclude node_modules --exclude data --exclude dist --exclude releases ./ pi@raspberrypi.local:~/moki/
```

## 3. Configuring `.env`

On the Pi, inside `~/moki`:

```bash
cp .env.example .env
```

```bash
openssl rand -hex 24
```

Edit `.env` and set at least:

- `MOKI_TOKEN=` the generated value (keep it: you'll use it on the Mac).
- `MOKI_PI_HOST=` the name or IP you use to reach the Pi from the Mac
  (`raspberrypi.local`, `192.168.1.50`…).
- If you are going to connect through several names (IP, `.local`, Tailscale), list them all in
  `MOKI_ALLOWED_HOSTS`, comma-separated.

`.env` never goes into the image (it is in `.dockerignore`).

## 4. Starting it

```bash
docker compose -f docker-compose.yml -f docker-compose.pi.yml up -d --build
```

- **First build on a Pi 4: ~10–20 min** (downloading the base image and Chromium, `npm ci` and
  the web bundle). Subsequent builds take much less thanks to the cache.
- Check that it is healthy:

```bash
docker compose -f docker-compose.yml -f docker-compose.pi.yml ps
```

```bash
docker logs moki --tail 20
```

You should see `Auth: MOKI_TOKEN activo` (MOKI_TOKEN active) and `Perfil de poca memoria`
(low-memory profile).

### Alternative: build on the Mac and ship the image

Faster than compiling on the Pi (an Apple Silicon Mac is already arm64):

```bash
docker buildx build --platform linux/arm64 -t moki:pi --load .
```

```bash
docker save moki:pi | gzip | ssh pi@raspberrypi.local 'gunzip | docker load'
```

Then on the Pi start it **without** `--build`:

```bash
docker compose -f docker-compose.yml -f docker-compose.pi.yml up -d
```

## 5. Using it from the Mac

**Editor:** open `http://<MOKI_PI_HOST>:7410` and log in with the token (a cookie is set so you
aren't asked again). Shortcut for your phone: `http://<pi>:7410/?token=<token>` sets the cookie
and cleans up the URL.

**Claude Code:**

```bash
claude mcp add --transport http moki http://raspberrypi.local:7410/mcp --header "Authorization: Bearer YOUR_TOKEN"
```

**Stdio-only clients:**

```bash
MOKI_URL=http://raspberrypi.local:7410 MOKI_TOKEN=YOUR_TOKEN node bin/moki-mcp.mjs
```

**Exports:** the `export` tools return `filePath` (path on the Pi, folder `~/moki/data/exports`)
and `url` (`http://<pi>:7410/api/exports/<file>`). Downloading from the Mac requires the token:

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" -O "http://raspberrypi.local:7410/api/exports/Desktop.png"
```

### Tailscale (recommended if you leave home)

Install Tailscale on the Pi and the Mac and use the Pi's MagicDNS name
(`moki-pi.your-tailnet.ts.net`): add it to `MOKI_ALLOWED_HOSTS` and set it as `MOKI_PI_HOST`.
That way nothing is opened to the outside and the traffic is encrypted. In that case you can stop
publishing the port on the LAN.

## 6. Memory: what to expect

Measured with the Pi's limits (2 CPUs, 2.5 GB) using the `MOKI_LOW_MEMORY=1` profile:

| Situation | Container memory |
|---|---|
| Idle (no Chromium) | ~150 MB |
| Agent working on 1–2 files + screenshots/exports | ~450–500 MB (measured peak: 484 MB) |

How it stays low:

- Chromium is launched only when an agent uses the MCP or something is exported.
- At most `MOKI_MAX_RUNTIMES=2` files with a runtime at the same time; the least recently used one
  is closed.
- Idle runtime → closed after 5 min; screenshot page → 2 min; the whole Chromium → 3 min with no
  pages. Relaunching it costs ~0.5–3 s on the first call.
- Node capped at a 512 MB heap and Chromium at a 384 MB JS heap per process; raster exports
  ≤ 8000 px.
- `tini` as PID 1 (`init: true`) reaps Chromium processes when they exit.

The container has a 2.5 GB `mem_limit` (adjustable with `MOKI_MEM_LIMIT`) so that, in the worst
case, the Pi's system stays responsive.

## 7. Troubleshooting

- **The container restarts or `docker logs` shows `Killed` / OOM:** lower `MOKI_MAX_RUNTIMES=1`,
  add swap and avoid huge exports (`MOKI_MAX_EXPORT_SIDE=4000`).

  2 GB of swap on Raspberry Pi OS: edit `/etc/dphys-swapfile` and set `CONF_SWAPSIZE=2048` and
  `CONF_MAXSWAP=2048`. Then:

  ```bash
  sudo dphys-swapfile setup && sudo dphys-swapfile swapon
  ```

- **`Tool call timed out` or `The Moki runtime did not start in time`:** the first call after a
  period of inactivity launches Chromium; on a Pi with a slow microSD it can take a while. Retry;
  if it keeps happening, check `docker logs moki` (`[browser]` / `[runtime …]` lines).
- **Chromium crashes (`Chromium se ha cerrado`, "Chromium has closed"):** it is relaunched
  automatically on the next call. If it happens often, raise `shm_size` in
  `docker-compose.pi.yml` or lower `MOKI_MAX_RUNTIMES`.
- **The agent gets a 403:** the name it uses to reach the Pi is not in `MOKI_ALLOWED_HOSTS`.
- **The agent gets a 401:** the `Authorization: Bearer …` header is missing or doesn't match.
- **The server won't start and says `MOKI_TOKEN` is missing:** this is intentional; Moki is not
  exposed to the network without a token.
