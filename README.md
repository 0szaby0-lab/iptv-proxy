# IPTV Auto Register + Proxy

auto-registers for a free IPTV trial on iptvload.org every 20 hours, then proxies the Xtream Codes API so you use a single permanent username/password in your IPTV player.

## deploy on render.com

1. push this repo to github
2. go to [render.com](https://render.com) → New → Web Service
3. connect your github repo
4. set environment variables:
   - `PROXY_USER` — your custom username (e.g. `myuser`)
   - `PROXY_PASS` — your custom password (e.g. `mypass123`)
5. deploy (render detects `render.yaml` automatically)

## IPTV player setup

in your IPTV player (TiviMate, Smarters, etc.):

| field | value |
|-------|-------|
| **Type** | Xtream Codes |
| **Server URL** | `https://your-app.onrender.com` |
| **Username** | your `PROXY_USER` value |
| **Password** | your `PROXY_PASS` value |

that's it. the proxy transparently forwards everything to the active trial server. every 20 hours it registers a fresh trial and swaps the credentials behind the scenes — you never need to change anything in your player.

## how it works

each 20-hour cycle:
1. creates a disposable email (guerrilla mail)
2. loads the registration page, extracts anti-spam tokens
3. requests a 6-digit email verification code via REST API
4. polls the inbox until the code arrives (~10 seconds)
5. verifies the code → gets verification token
6. submits the WPForms form with all fields + verified token
7. waits 90s, reads IPTV credentials from inbox
8. stores credentials in memory for the proxy

## proxy endpoints

| endpoint | description |
|----------|-------------|
| `GET /` | status JSON |
| `GET /trigger` | manually trigger a new registration |
| `GET /player_api.php?username=X&password=Y` | Xtream Codes API |
| `GET /get.php?username=X&password=Y&type=m3u_plus` | M3U playlist |
| `GET /xmltv.php?username=X&password=Y` | EPG data |
| `GET /live/X/Y/stream.ts` | live stream |
| `GET /movie/X/Y/file.mp4` | VOD |
| `GET /series/X/Y/file.mp4` | series |

## local test

```bash
npm install
PROXY_USER=myuser PROXY_PASS=mypass node server.js
```

## keep-alive on render free tier

render free tier spins down after 15 min idle. use [cron-job.org](https://cron-job.org) to ping your render URL every 14 minutes.
