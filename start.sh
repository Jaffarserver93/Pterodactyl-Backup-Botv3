#!/usr/bin/env bash
set -euo pipefail

CONFIG_FILE="$(dirname "$0")/.env"
SESSION_FILE="$(dirname "$0")/scripts/.telegram_session"

BOLD="\033[1m"
GREEN="\033[32m"
CYAN="\033[36m"
YELLOW="\033[33m"
RESET="\033[0m"

echo ""
echo -e "${BOLD}${CYAN}╔══════════════════════════════════════╗${RESET}"
echo -e "${BOLD}${CYAN}║   Pterodactyl → Telegram Backup Bot  ║${RESET}"
echo -e "${BOLD}${CYAN}╚══════════════════════════════════════╝${RESET}"
echo ""

# ── 1. Check / install Node.js ─────────────────────────────────────────────────

if ! command -v node &>/dev/null; then
  echo -e "${YELLOW}Node.js not found. Installing via nvm...${RESET}"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  nvm install 22
  nvm use 22
fi

NODE_VERSION=$(node --version)
echo -e "${GREEN}✔ Node.js ${NODE_VERSION}${RESET}"

# ── 2. Check / install pnpm ────────────────────────────────────────────────────

if ! command -v pnpm &>/dev/null; then
  echo -e "${YELLOW}pnpm not found. Installing...${RESET}"
  npm install -g pnpm
fi

PNPM_VERSION=$(pnpm --version)
echo -e "${GREEN}✔ pnpm ${PNPM_VERSION}${RESET}"

# ── 3. Install workspace dependencies ─────────────────────────────────────────

echo ""
echo -e "${BOLD}Installing dependencies...${RESET}"
cd "$(dirname "$0")"
pnpm install --frozen-lockfile 2>&1 | grep -E "(Done|ERR|error)" || true
echo -e "${GREEN}✔ Dependencies ready${RESET}"

# ── 4. First-time config setup ────────────────────────────────────────────────

if [ ! -f "$CONFIG_FILE" ]; then
  echo ""
  echo -e "${BOLD}First-time setup — enter your credentials:${RESET}"
  echo -e "${CYAN}(These are saved locally to .env and never shared)${RESET}"
  echo ""

  prompt() {
    local label="$1"
    local var="$2"
    local secret="${3:-false}"
    local value=""
    while [ -z "$value" ]; do
      if [ "$secret" = "true" ]; then
        read -rsp "  ${label}: " value
        echo ""
      else
        read -rp "  ${label}: " value
      fi
      if [ -z "$value" ]; then
        echo -e "  ${YELLOW}This field is required.${RESET}"
      fi
    done
    eval "$var='$value'"
  }

  echo -e "${BOLD}── Pterodactyl ──────────────────────────────${RESET}"
  prompt "Panel URL (e.g. https://panel.example.com)" PTERO_URL
  prompt "API Key (ptlc_...)" PTERO_API_KEY true
  prompt "Server ID (8-char hex, e.g. e4b4246c)" PTERO_SERVER_ID

  echo ""
  echo -e "${BOLD}── Telegram ─────────────────────────────────${RESET}"
  echo -e "${CYAN}  Get API ID and Hash from https://my.telegram.org/apps${RESET}"
  prompt "API ID (numeric)" TELEGRAM_API_ID
  prompt "API Hash" TELEGRAM_API_HASH true
  prompt "Phone Number (with country code, e.g. +91...)" TELEGRAM_PHONE

  cat > "$CONFIG_FILE" <<EOF
PTERO_URL=${PTERO_URL}
PTERO_API_KEY=${PTERO_API_KEY}
PTERO_SERVER_ID=${PTERO_SERVER_ID}
TELEGRAM_API_ID=${TELEGRAM_API_ID}
TELEGRAM_API_HASH=${TELEGRAM_API_HASH}
TELEGRAM_PHONE=${TELEGRAM_PHONE}
EOF

  echo ""
  echo -e "${GREEN}✔ Config saved to .env${RESET}"
else
  echo -e "${GREEN}✔ Config loaded from .env${RESET}"
fi

# Load the config
set -a
# shellcheck disable=SC1090
source "$CONFIG_FILE"
set +a

# ── 5. Session info ───────────────────────────────────────────────────────────

if [ -f "$SESSION_FILE" ] && [ -s "$SESSION_FILE" ]; then
  echo -e "${GREEN}✔ Telegram session found — no OTP needed${RESET}"
else
  echo ""
  echo -e "${YELLOW}No Telegram session found.${RESET}"
  echo -e "When the bot starts, it will send a login code to your Telegram account."
  echo -e "You will need to enter it below when prompted."
  echo ""
fi

# ── 6. Start the bot ──────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}${GREEN}Starting backup bot...${RESET}"
echo -e "${CYAN}Press Ctrl+C to stop.${RESET}"
echo ""

exec pnpm --filter @workspace/scripts run backup-bot
