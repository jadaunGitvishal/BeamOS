#!/bin/bash
# BeamOS - Raspberry Pi Player Setup Script
#
# Connects this Raspberry Pi to your existing BeamOS server as a display.
# This Pi only displays content - it does not run its own server.
#
# Usage:
#   sudo ./raspberry-pi-setup.sh https://your-beamos-server.com
#   sudo ./raspberry-pi-setup.sh                          # will prompt for the URL
#
# Works on Raspberry Pi OS Lite or Desktop (Bookworm / Bullseye)
# Tested on Pi 3B+, Pi 4, Pi 5

set -euo pipefail

# -- Colors --
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${GREEN}[BeamOS]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
err()  { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# -- Parse arguments --
SERVER_URL="${1:-}"

if [[ "$SERVER_URL" == "--help" || "$SERVER_URL" == "-h" ]]; then
    echo "Usage: sudo ./raspberry-pi-setup.sh [SERVER_URL]"
    echo ""
    echo "Example:"
    echo "  sudo ./raspberry-pi-setup.sh https://your-beamos-server.com"
    exit 0
fi

# -- Root check --
if [ "$(id -u)" -ne 0 ]; then
    err "This script must be run as root. Try: sudo bash raspberry-pi-setup.sh"
fi

# -- Architecture check --
ARCH=$(uname -m)
if [[ "$ARCH" != "aarch64" && "$ARCH" != "armv7l" ]]; then
    warn "Detected architecture: $ARCH (expected aarch64 or armv7l for Raspberry Pi)"
    read -p "Continue anyway? (y/N) " -n 1 -r; echo
    [[ ! $REPLY =~ ^[Yy]$ ]] && exit 1
fi

# -- Ask for server URL if not supplied --
if [ -z "$SERVER_URL" ]; then
    echo ""
    echo -e "${BLUE}======================================${NC}"
    echo -e "${BLUE}   BeamOS Raspberry Pi Player Setup   ${NC}"
    echo -e "${BLUE}======================================${NC}"
    echo ""
    read -p "Enter your BeamOS server URL (e.g. https://cxo1-ai.onrender.com): " SERVER_URL
fi

[ -z "$SERVER_URL" ] && err "A server URL is required."

# Strip trailing slash from server URL
SERVER_URL="${SERVER_URL%/}"
KIOSK_URL="${SERVER_URL}/player"
log "Server: $SERVER_URL"

LOG_FILE="/var/log/beamos-setup.log"
echo ""
log "Setup log: $LOG_FILE"
exec > >(tee -a "$LOG_FILE") 2>&1

# -- Detect Pi OS variant --
HAS_DESKTOP=false
if dpkg -l xserver-xorg 2>/dev/null | grep -q "^ii"; then
    HAS_DESKTOP=true
    log "Detected: Pi OS with Desktop"
else
    log "Detected: Pi OS Lite (headless)"
fi

# ============================================================
# 1. System packages
# ============================================================
log "Updating system packages..."
apt-get update -qq
apt-get upgrade -y -qq

log "Installing base dependencies..."
apt-get install -y -qq \
    curl wget unzip htop \
    avahi-daemon \
    fonts-liberation fonts-noto-color-emoji \
    >> "$LOG_FILE" 2>&1

# Determine the runtime user
PI_USER="${SUDO_USER:-pi}"
PI_HOME=$(eval echo "~$PI_USER")

# ============================================================
# 2. Kiosk display packages
# ============================================================
log "Installing kiosk packages..."
if [ "$HAS_DESKTOP" = false ]; then
    apt-get install -y -qq \
        xserver-xorg x11-xserver-utils xinit \
        chromium-browser \
        unclutter xdotool \
        >> "$LOG_FILE" 2>&1
else
    apt-get install -y -qq unclutter xdotool >> "$LOG_FILE" 2>&1
    if ! command -v chromium-browser &>/dev/null && ! command -v chromium &>/dev/null; then
        apt-get install -y -qq chromium-browser >> "$LOG_FILE" 2>&1
    fi
fi

CHROMIUM_BIN=$(command -v chromium-browser 2>/dev/null || command -v chromium 2>/dev/null || echo "/usr/bin/chromium-browser")

# ============================================================
# 3. Kiosk launcher script
# ============================================================
log "Creating kiosk launcher..."
cat > "$PI_HOME/beamos-kiosk.sh" << KIOSKEOF
#!/bin/bash
# BeamOS Kiosk - launches Chromium in fullscreen player mode
KIOSK_URL="${KIOSK_URL}"

sleep 2

xset s off
xset s noblank
xset -dpms
xset s 0 0

unclutter -idle 3 -root &

CDIR="\$HOME/.config/chromium/Default"
mkdir -p "\$CDIR"
if [ -f "\$CDIR/Preferences" ]; then
    sed -i 's/"exited_cleanly":false/"exited_cleanly":true/' "\$CDIR/Preferences" 2>/dev/null || true
    sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/' "\$CDIR/Preferences" 2>/dev/null || true
fi

SCREEN_RES=\$(xrandr 2>/dev/null | grep ' connected' | grep -oE '[0-9]+x[0-9]+' | head -1)
SCREEN_W=\${SCREEN_RES%%x*}
SCREEN_H=\${SCREEN_RES##*x}
if [ -z "\$SCREEN_W" ] || [ -z "\$SCREEN_H" ]; then
    SCREEN_W=1920
    SCREEN_H=1080
fi

exec ${CHROMIUM_BIN} \\
    --kiosk \\
    --window-position=0,0 \\
    --window-size=\${SCREEN_W},\${SCREEN_H} \\
    --noerrdialogs \\
    --disable-infobars \\
    --disable-session-crashed-bubble \\
    --disable-features=TranslateUI \\
    --disable-component-update \\
    --check-for-update-interval=31536000 \\
    --autoplay-policy=no-user-gesture-required \\
    --no-first-run \\
    --disable-pinch \\
    --overscroll-history-navigation=0 \\
    --disable-translate \\
    --disable-sync \\
    --disable-background-networking \\
    --disable-default-apps \\
    --disable-extensions \\
    --disable-hang-monitor \\
    --disable-popup-blocking \\
    --disable-prompt-on-repost \\
    --metrics-recording-only \\
    --safebrowsing-disable-auto-update \\
    --ignore-certificate-errors \\
    "\$KIOSK_URL"
KIOSKEOF

chmod +x "$PI_HOME/beamos-kiosk.sh"
chown "$PI_USER":"$PI_USER" "$PI_HOME/beamos-kiosk.sh"

# ============================================================
# 4. Xinitrc (Pi OS Lite - starts kiosk from console)
# ============================================================
if [ "$HAS_DESKTOP" = false ]; then
    cat > "$PI_HOME/.xinitrc" << 'EOF'
#!/bin/bash
exec ~/beamos-kiosk.sh
EOF
    chmod +x "$PI_HOME/.xinitrc"
    chown "$PI_USER":"$PI_USER" "$PI_HOME/.xinitrc"
fi

# ============================================================
# 5. Kiosk systemd service
# ============================================================
log "Creating kiosk service..."

if [ "$HAS_DESKTOP" = false ]; then
    cat > /etc/systemd/system/beamos-kiosk.service << EOF
[Unit]
Description=BeamOS Kiosk Display
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${PI_USER}
Environment=DISPLAY=:0
Environment=XAUTHORITY=${PI_HOME}/.Xauthority
ExecStartPre=/bin/sleep 3
ExecStart=/usr/bin/startx ${PI_HOME}/.xinitrc -- :0 -nolisten tcp vt1
Restart=always
RestartSec=10

TTYPath=/dev/tty1
StandardInput=tty
StandardOutput=journal
StandardError=journal
SyslogIdentifier=beamos-kiosk

[Install]
WantedBy=multi-user.target
EOF
else
    cat > /etc/systemd/system/beamos-kiosk.service << EOF
[Unit]
Description=BeamOS Kiosk Display
After=graphical.target
Wants=graphical.target

[Service]
Type=simple
User=${PI_USER}
Environment=DISPLAY=:0
ExecStartPre=/bin/sleep 5
ExecStart=/bin/bash ${PI_HOME}/beamos-kiosk.sh
Restart=always
RestartSec=10

StandardOutput=journal
StandardError=journal
SyslogIdentifier=beamos-kiosk

[Install]
WantedBy=graphical.target
EOF
fi

systemctl daemon-reload
systemctl enable beamos-kiosk.service
log "Kiosk service enabled"

if [ "$HAS_DESKTOP" = true ]; then
    AUTOSTART_DIR="$PI_HOME/.config/autostart"
    mkdir -p "$AUTOSTART_DIR"
    cat > "$AUTOSTART_DIR/beamos.desktop" << EOF
[Desktop Entry]
Type=Application
Name=BeamOS Player
Exec=${PI_HOME}/beamos-kiosk.sh
X-GNOME-Autostart-enabled=true
EOF
    chown -R "$PI_USER":"$PI_USER" "$AUTOSTART_DIR"
fi

# ============================================================
# 6. Auto-login on tty1 (Lite only)
# ============================================================
if [ "$HAS_DESKTOP" = false ]; then
    log "Configuring auto-login on tty1..."
    mkdir -p /etc/systemd/system/getty@tty1.service.d
    cat > /etc/systemd/system/getty@tty1.service.d/autologin.conf << EOF
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin ${PI_USER} --noclear %I \$TERM
EOF
fi

# ============================================================
# 7. Pi display and boot optimizations
# ============================================================
log "Applying display optimizations..."

CONFIG_FILE=""
for p in /boot/firmware/config.txt /boot/config.txt; do
    [ -f "$p" ] && CONFIG_FILE="$p" && break
done

if [ -n "$CONFIG_FILE" ]; then
    if ! grep -q "^gpu_mem=" "$CONFIG_FILE"; then
        echo -e "\n# BeamOS: GPU memory for smooth video" >> "$CONFIG_FILE"
        echo "gpu_mem=128" >> "$CONFIG_FILE"
        log "GPU memory: 128MB"
    fi

    if ! grep -q "^disable_overscan=1" "$CONFIG_FILE"; then
        echo "disable_overscan=1" >> "$CONFIG_FILE"
        log "Overscan disabled"
    fi
fi

for p in /boot/firmware/cmdline.txt /boot/cmdline.txt; do
    if [ -f "$p" ]; then
        if ! grep -q "consoleblank=0" "$p"; then
            sed -i 's/$/ consoleblank=0/' "$p"
            log "Console blanking disabled"
        fi
        break
    fi
done

if [ "$HAS_DESKTOP" = true ] && [ -f /etc/lightdm/lightdm.conf ]; then
    sed -i 's/#xserver-command=X/xserver-command=X -s 0 -dpms/' /etc/lightdm/lightdm.conf
fi

if grep -q "#RuntimeWatchdogSec=0" /etc/systemd/system.conf 2>/dev/null; then
    sed -i 's/#RuntimeWatchdogSec=0/RuntimeWatchdogSec=10/' /etc/systemd/system.conf
    log "Hardware watchdog enabled (10s)"
fi

# ============================================================
# 8. MOTD
# ============================================================
cat > /etc/motd << 'MOTDEOF'

  BeamOS Player

 Commands:
   sudo systemctl [start|stop|restart] beamos-kiosk
   sudo journalctl -u beamos-kiosk -f

MOTDEOF

# ============================================================
# 9. Clean up any legacy screentinker/remotedisplay naming
# ============================================================
for legacy in screentinker remotedisplay; do
    if [ -f "/etc/systemd/system/${legacy}-kiosk.service" ] || [ -f "/etc/systemd/system/${legacy}.service" ]; then
        log "Cleaning up legacy ${legacy} service..."
        systemctl stop "${legacy}-kiosk.service" 2>/dev/null || true
        systemctl stop "${legacy}.service" 2>/dev/null || true
        systemctl disable "${legacy}-kiosk.service" 2>/dev/null || true
        systemctl disable "${legacy}.service" 2>/dev/null || true
        rm -f "/etc/systemd/system/${legacy}-kiosk.service"
        rm -f "/etc/systemd/system/${legacy}.service"
        rm -f "$PI_HOME/${legacy}-kiosk.sh"
        rm -f "$PI_HOME/.config/autostart/${legacy}.desktop"
        systemctl daemon-reload
    fi
done

# ============================================================
# Done
# ============================================================
echo ""
echo -e "${GREEN}======================================${NC}"
echo -e "${GREEN}   BeamOS Setup Complete!${NC}"
echo -e "${GREEN}======================================${NC}"
echo ""
echo "Server: $SERVER_URL"
echo ""
echo "After reboot this Pi will:"
echo "  - Open the player in fullscreen kiosk mode"
echo "  - Auto-reconnect if the server goes down"
echo ""
echo "To pair:"
echo "  1. Reboot:  sudo reboot"
echo "  2. The pairing screen will appear on the TV"
echo "  3. Enter the code in your BeamOS dashboard"
echo ""
echo "Service:"
echo "  sudo systemctl [start|stop|restart] beamos-kiosk"
echo ""
echo -e "${YELLOW}Reboot to start:  sudo reboot${NC}"
echo ""