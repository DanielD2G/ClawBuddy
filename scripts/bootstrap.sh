#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
fail()  { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

RAW_BASE="https://raw.githubusercontent.com/DanielD2G/AgentBuddy/main"

# ── 0. Create project directory ───────────────────
if [[ ! -f "docker-compose.yml" ]]; then
  mkdir -p AgentBuddy && cd AgentBuddy
  info "Downloading docker-compose.yml..."
  curl -fsSL "$RAW_BASE/docker-compose.yml" -o docker-compose.yml
  info "Downloading .env.example..."
  curl -fsSL "$RAW_BASE/.env.example" -o .env.example
  ok "Files downloaded"
fi

# ── 1. Check Docker ──────────────────────────────
info "Checking Docker..."

if ! command -v docker &>/dev/null; then
  warn "Docker not found. Attempting to install..."

  if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    if command -v apt-get &>/dev/null; then
      info "Installing Docker via apt..."
      sudo apt-get update -qq
      sudo apt-get install -y -qq docker.io docker-compose-plugin
      sudo systemctl enable --now docker
      sudo usermod -aG docker "$USER"
      warn "You were added to the docker group. You may need to log out and back in."
    else
      fail "Unsupported Linux package manager. Install Docker manually: https://docs.docker.com/engine/install/"
    fi
  elif [[ "$OSTYPE" == "darwin"* ]]; then
    if command -v brew &>/dev/null; then
      info "Installing Docker via Homebrew..."
      brew install --cask docker
      echo ""
      fail "Docker Desktop was installed. Please open Docker Desktop, wait for it to start, then re-run this script."
    else
      fail "Install Docker Desktop from https://www.docker.com/products/docker-desktop/ then re-run this script."
    fi
  else
    fail "Unsupported OS. Install Docker manually: https://docs.docker.com/engine/install/"
  fi
fi

if ! docker info &>/dev/null; then
  fail "Docker is installed but not running. Start Docker Desktop (macOS) or 'sudo systemctl start docker' (Linux), then re-run."
fi

if ! docker compose version &>/dev/null; then
  fail "Docker Compose plugin not found. Install it: https://docs.docker.com/compose/install/"
fi

ok "Docker $(docker --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+') + Compose $(docker compose version --short)"

# ── 2. Check ports ───────────────────────────────
info "Checking ports..."

PORTS=(4321 4000 5433 6333 6334 6380 9000 9001 9090)
BUSY=()

for port in "${PORTS[@]}"; do
  if lsof -iTCP:"$port" -sTCP:LISTEN -t &>/dev/null; then
    BUSY+=("$port")
  fi
done

if [[ ${#BUSY[@]} -gt 0 ]]; then
  fail "Ports in use: ${BUSY[*]}. Free them before continuing.\n       Use 'lsof -i :PORT' to find what's using each port."
fi

ok "All required ports are free"

# ── 3. Setup .env ────────────────────────────────
info "Setting up environment..."

if [[ ! -f .env ]]; then
  cp .env.example .env
  info "Created .env from .env.example"

  # Generate random ENCRYPTION_SECRET
  SECRET=$(openssl rand -base64 32)
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s|change-me-to-a-random-secret|${SECRET}|" .env
  else
    sed -i "s|change-me-to-a-random-secret|${SECRET}|" .env
  fi
  ok "Generated random ENCRYPTION_SECRET"

  echo ""
  warn "Add your AI provider API keys to .env before using the app:"
  warn "  OPENAI_API_KEY, GEMINI_API_KEY, or ANTHROPIC_API_KEY"
  echo ""
else
  ok ".env already exists"

  # Check ENCRYPTION_SECRET
  if grep -q "change-me-to-a-random-secret" .env; then
    SECRET=$(openssl rand -base64 32)
    if [[ "$OSTYPE" == "darwin"* ]]; then
      sed -i '' "s|change-me-to-a-random-secret|${SECRET}|" .env
    else
      sed -i "s|change-me-to-a-random-secret|${SECRET}|" .env
    fi
    ok "Generated random ENCRYPTION_SECRET (was still default)"
  fi
fi

# ── 4. Pull & start ─────────────────────────────
info "Pulling images and starting services..."
docker compose up -d

# ── 5. Wait for health ──────────────────────────
info "Waiting for API to be healthy..."

TIMEOUT=120
ELAPSED=0

while [[ $ELAPSED -lt $TIMEOUT ]]; do
  STATUS=$(docker compose ps api --format json 2>/dev/null | grep -o '"Health":"[^"]*"' | head -1 || true)
  if [[ "$STATUS" == *"healthy"* ]]; then
    break
  fi
  sleep 5
  ELAPSED=$((ELAPSED + 5))
  echo -ne "\r  Waiting... ${ELAPSED}s / ${TIMEOUT}s"
done
echo ""

if [[ $ELAPSED -ge $TIMEOUT ]]; then
  warn "API did not become healthy within ${TIMEOUT}s. Check logs:"
  warn "  docker compose logs api"
  echo ""
else
  ok "API is healthy"
fi

# ── 6. Done ──────────────────────────────────────
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  AgentBuddy is running!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  Web app:       ${CYAN}http://localhost:4321${NC}"
echo -e "  API:           ${CYAN}http://localhost:4000${NC}"
echo -e "  MinIO console: ${CYAN}http://localhost:9001${NC}"
echo ""
echo -e "  Logs:  docker compose logs -f"
echo -e "  Stop:  docker compose down"
echo ""
