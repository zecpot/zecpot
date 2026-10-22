#!/bin/bash
# Makes zecPOT and its Cloudflare tunnel start by themselves at boot and restart if they stop.
#   bash tools/install-services.sh install     (asks for your Mac password once)
#   bash tools/install-services.sh status
#   bash tools/install-services.sh logs
#   bash tools/install-services.sh restart     (after changing .env or updating the code)
#   bash tools/install-services.sh stop        (pause the server, e.g. to use a wallet with zingo-cli)
#   bash tools/install-services.sh start       (start it again)
#   bash tools/install-services.sh uninstall
# They run as your user, not root. Logs go to var/logs/. The server never logs visitors.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ME="$(id -un)"
LOGS="${ROOT}/var/logs"
D=/Library/LaunchDaemons
SERVER=com.zecpot.server
TUNNEL=com.zecpot.tunnel

plist() { # label script log
  cat <<XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$1</string>
  <key>UserName</key><string>${ME}</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$2</string></array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>EnvironmentVariables</key><dict><key>HOME</key><string>${HOME}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${LOGS}/$3.log</string>
  <key>StandardErrorPath</key><string>${LOGS}/$3.log</string>
</dict></plist>
XML
}

case "${1:-}" in
  install)
    command -v node >/dev/null || { echo "node not found (brew install node)" >&2; exit 1; }
    command -v cloudflared >/dev/null || { echo "cloudflared not found (brew install cloudflared)" >&2; exit 1; }
    [ -f "${ROOT}/.env" ] || { echo "no ${ROOT}/.env" >&2; exit 1; }
    ls "${HOME}"/.cloudflared/*.json >/dev/null 2>&1 || { echo "no tunnel credentials in ~/.cloudflared (run cloudflared tunnel create zecpot)" >&2; exit 1; }
    if lsof -nP -iTCP:8787 -sTCP:LISTEN >/dev/null 2>&1; then
      echo "Something is already running on port 8787. Stop your Terminal copy of zecPOT first (Ctrl+C), then run this again." >&2; exit 1
    fi
    if pgrep -f "cloudflared.*tunnel run" >/dev/null; then
      echo "A cloudflared tunnel is already running. Stop it first (Ctrl+C in its window), then run this again." >&2; exit 1
    fi
    mkdir -p "${LOGS}"
    chmod +x "${ROOT}/tools/run-live.sh" "${ROOT}/tools/run-tunnel.sh"
    TMP="$(mktemp -d)"
    plist "${SERVER}" "${ROOT}/tools/run-live.sh" server > "${TMP}/${SERVER}.plist"
    plist "${TUNNEL}" "${ROOT}/tools/run-tunnel.sh" tunnel > "${TMP}/${TUNNEL}.plist"
    plutil -lint "${TMP}"/*.plist >/dev/null
    echo "Installing two background services (your Mac password is needed once)..."
    for L in "${SERVER}" "${TUNNEL}"; do
      sudo launchctl bootout "system/${L}" 2>/dev/null || true
      sudo install -m 644 -o root -g wheel "${TMP}/${L}.plist" "${D}/${L}.plist"
      sudo launchctl bootstrap system "${D}/${L}.plist"
    done
    rm -rf "${TMP}"
    echo "Done. They start now and at every boot. Check with: bash tools/install-services.sh status"
    ;;
  status)
    for L in "${SERVER}" "${TUNNEL}"; do
      if launchctl print "system/${L}" >/dev/null 2>&1; then
        state="$(launchctl print "system/${L}" | awk -F'= ' '/^\tstate/ {print $2; exit}')"
        pid="$(launchctl print "system/${L}" | awk -F'= ' '/^\tpid/ {print $2; exit}')"
        echo "${L}: ${state:-unknown}${pid:+ (process ${pid})}"
      else
        echo "${L}: not installed"
      fi
    done
    curl -s -o /dev/null -w "local site: %{http_code}\n" http://127.0.0.1:8787/ || true
    ;;
  logs)
    tail -n 25 "${LOGS}/server.log" 2>/dev/null; echo "--- tunnel"; tail -n 8 "${LOGS}/tunnel.log" 2>/dev/null
    ;;
  restart)
    sudo launchctl kickstart -k "system/${SERVER}"
    echo "Server restarted. The tunnel keeps running."
    ;;
  stop)
    sudo launchctl bootout "system/${SERVER}" 2>/dev/null || true
    echo "Server stopped (the tunnel keeps running; zecpot.com shows an error until you start it)."
    echo "Start it again with: bash tools/install-services.sh start"
    ;;
  start)
    sudo launchctl bootstrap system "${D}/${SERVER}.plist" 2>/dev/null || sudo launchctl kickstart "system/${SERVER}"
    echo "Server started."
    ;;
  uninstall)
    for L in "${SERVER}" "${TUNNEL}"; do
      sudo launchctl bootout "system/${L}" 2>/dev/null || true
      sudo rm -f "${D}/${L}.plist"
    done
    echo "Removed. Run zecPOT in Terminal again if you need it."
    ;;
  *)
    echo "usage: bash tools/install-services.sh install | status | logs | restart | stop | start | uninstall" >&2; exit 1
    ;;
esac
