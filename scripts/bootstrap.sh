#!/usr/bin/env bash
set -euo pipefail

# ── Colors & Logging ─────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}  ✓${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
fail()  { echo -e "${RED}  ✗  $*${NC}"; exit 1; }
step_header() { echo -e "\n${BOLD}${CYAN}━━━ Step $1/$TOTAL_STEPS: $2 ━━━${NC}\n"; }

TOTAL_STEPS=5
RAW_BASE="https://raw.githubusercontent.com/DanielD2G/ClawBuddy/main"
INFRA_STACK_NAME="clawbuddy-infra"
APP_STACK_NAME="clawbuddy-app"
SHARED_NETWORK_NAME="clawbuddy_shared"
INFRA_COMPOSE_FILE="docker-compose.infra.yml"
APP_COMPOSE_FILE="docker-compose.app.yml"
LEGACY_COMPOSE_FILE="docker-compose.yml"
HOST_ARCH=""

# ── Collected config (globals) ───────────────────────
AI_PROVIDER=""
EMBEDDING_PROVIDER=""
OPENAI_KEY=""
ANTHROPIC_KEY=""
GEMINI_KEY=""
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
APP_URL=""
SKIP_API_SETUP=false

# ── Trap ─────────────────────────────────────────────
cleanup() {
  local exit_code=$?
  if [[ $exit_code -ne 0 ]]; then
    echo ""
    warn "Setup was interrupted. You can safely re-run this script to continue."
  fi
}
trap cleanup EXIT

# ── Utility Functions ────────────────────────────────

# Read from terminal even when script is piped via curl | bash
read_input() {
  local prompt="$1"
  local var_name="$2"
  local default="${3:-}"

  if [[ -n "$default" ]]; then
    prompt="$prompt [$default]"
  fi

  if [[ -t 0 ]]; then
    read -rp "  $prompt " "$var_name"
  else
    read -rp "  $prompt " "$var_name" </dev/tty
  fi

  # Apply default if empty
  if [[ -z "${!var_name}" && -n "$default" ]]; then
    printf -v "$var_name" '%s' "$default"
  fi
}

# Read a secret value (no echo)
read_secret() {
  local prompt="$1"
  local var_name="$2"

  if [[ -t 0 ]]; then
    read -rsp "  $prompt " "$var_name"
  else
    read -rsp "  $prompt " "$var_name" </dev/tty
  fi
  echo ""
}

# Numbered menu → sets MENU_RESULT to the value
prompt_choice() {
  local prompt="$1"
  shift
  local options=("$@")
  local count=${#options[@]}

  echo -e "  ${BOLD}$prompt${NC}"
  echo ""
  for i in "${!options[@]}"; do
    echo -e "    ${CYAN}$((i + 1)))${NC} ${options[$i]}"
  done
  echo ""

  while true; do
    local choice
    read_input "Enter choice [1-$count]:" choice
    if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= count )); then
      MENU_RESULT=$((choice - 1))
      return
    fi
    echo -e "  ${RED}Invalid choice. Please enter a number between 1 and $count.${NC}"
  done
}

# y/n prompt → returns 0 for yes, 1 for no
prompt_yes_no() {
  local prompt="$1"
  local default="${2:-n}"

  local hint
  if [[ "$default" == "y" ]]; then
    hint="Y/n"
  else
    hint="y/N"
  fi

  while true; do
    local answer
    read_input "$prompt ($hint):" answer "$default"
    case "${answer,,}" in
      y|yes) return 0 ;;
      n|no)  return 1 ;;
      *)     echo -e "  ${RED}Please answer y or n.${NC}" ;;
    esac
  done
}

# Prompt for API key with format validation and retry
prompt_api_key() {
  local provider_name="$1"
  local pattern="$2"
  local hint="$3"
  local var_name="$4"

  while true; do
    local key
    read_secret "Paste your $provider_name API key:" key

    if [[ -z "$key" ]]; then
      echo ""
      if prompt_yes_no "Skip $provider_name key for now?" "n"; then
        printf -v "$var_name" ''
        warn "Skipped $provider_name key. You can add it later in .env"
        return
      fi
      continue
    fi

    if [[ "$key" =~ $pattern ]]; then
      printf -v "$var_name" '%s' "$key"
      ok "$provider_name API key set"
      return
    fi

    echo -e "  ${RED}Invalid format. $hint${NC}"
    echo -e "  ${DIM}Try again or press Enter to skip.${NC}"
  done
}

# Show instructions in a box
show_guide() {
  local title="$1"
  shift
  local lines=("$@")

  local max_len=${#title}
  for line in "${lines[@]}"; do
    local stripped
    stripped=$(echo -e "$line" | sed 's/\x1b\[[0-9;]*m//g')
    (( ${#stripped} > max_len )) && max_len=${#stripped}
  done
  max_len=$((max_len + 2))

  local border
  border=$(printf '─%.0s' $(seq 1 $((max_len + 2))))

  echo ""
  echo -e "  ${DIM}┌─${border}─┐${NC}"
  printf "  ${DIM}│${NC}  ${BOLD}%-${max_len}s${NC}  ${DIM}│${NC}\n" "$title"
  echo -e "  ${DIM}│${NC}  $(printf ' %.0s' $(seq 1 $max_len))  ${DIM}│${NC}"
  for line in "${lines[@]}"; do
    local stripped
    stripped=$(echo -e "$line" | sed 's/\x1b\[[0-9;]*m//g')
    local padding=$((max_len - ${#stripped}))
    local pad
    pad=$(printf ' %.0s' $(seq 1 $padding) 2>/dev/null || true)
    echo -e "  ${DIM}│${NC}  ${line}${pad}  ${DIM}│${NC}"
  done
  echo -e "  ${DIM}└─${border}─┘${NC}"
  echo ""
}

# Set a variable in the .env file
set_env_var() {
  local key="$1"
  local value="$2"
  local file="${3:-.env}"
  local tmp_file

  if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    fail "Value for ${key} contains an unsupported newline."
  fi

  tmp_file=$(mktemp)

  awk -v k="$key" -v v="$value" '
    BEGIN { done = 0 }
    index($0, k "=") == 1 {
      print k "=" v
      done = 1
      next
    }
    { print }
    END {
      if (!done) {
        print k "=" v
      }
    }
  ' "$file" > "$tmp_file" || {
    rm -f "$tmp_file"
    fail "Could not update ${file}."
  }

  mv "$tmp_file" "$file"
}

# Detect OS type
detect_os() {
  if [[ -f /proc/version ]] && grep -qi "microsoft\|wsl" /proc/version 2>/dev/null; then
    OS_TYPE="wsl"
  elif [[ "$OSTYPE" == "darwin"* ]]; then
    OS_TYPE="macos"
  elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    if command -v apt-get &>/dev/null; then
      OS_TYPE="linux-apt"
    elif command -v dnf &>/dev/null; then
      OS_TYPE="linux-dnf"
    elif command -v yum &>/dev/null; then
      OS_TYPE="linux-yum"
    else
      OS_TYPE="linux-unknown"
    fi
  else
    OS_TYPE="unsupported"
  fi
}

detect_host_arch() {
  local arch
  arch=$(uname -m 2>/dev/null || echo "unknown")
  case "$arch" in
    arm64|aarch64) HOST_ARCH="arm64" ;;
    x86_64|amd64) HOST_ARCH="amd64" ;;
    *) HOST_ARCH="$arch" ;;
  esac
}

is_stack_active() {
  local stack_name="$1"
  docker stack ls --format '{{.Name}}' 2>/dev/null | grep -q "^${stack_name}$"
}

is_any_stack_active() {
  is_stack_active "$INFRA_STACK_NAME" || is_stack_active "$APP_STACK_NAME"
}

has_legacy_compose_installation() {
  [[ -f "$LEGACY_COMPOSE_FILE" ]] || return 1
  docker compose -f "$LEGACY_COMPOSE_FILE" ps -q 2>/dev/null | grep -q .
}

install_files_exist() {
  [[ -f "$INFRA_COMPOSE_FILE" && -f "$APP_COMPOSE_FILE" ]]
}

strip_wrapping_quotes() {
  local value="$1"
  if [[ ${#value} -ge 2 ]]; then
    local first_char="${value:0:1}"
    local last_char="${value:${#value}-1:1}"
    if [[ "$first_char" == "$last_char" && ( "$first_char" == "\"" || "$first_char" == "'" ) ]]; then
      printf '%s' "${value:1:${#value}-2}"
      return
    fi
  fi
  if [[ "$value" =~ ^\"(.*)\"$ ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
    return
  fi
  printf '%s' "$value"
}

normalize_env_file() {
  local file="${1:-.env}"
  local tmp_file
  tmp_file=$(mktemp)

  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ ^[[:space:]]*# || "$line" != *=* ]]; then
      printf '%s\n' "$line" >> "$tmp_file"
      continue
    fi

    local key="${line%%=*}"
    local value="${line#*=}"
    value=$(strip_wrapping_quotes "$value")
    printf '%s=%s\n' "$key" "$value" >> "$tmp_file"
  done < "$file"

  mv "$tmp_file" "$file"
}

validate_stack_env_file() {
  local file="${1:-.env}"
  local required_keys=(
    "AI_PROVIDER"
    "EMBEDDING_PROVIDER"
    "ENCRYPTION_SECRET"
    "DATABASE_URL"
    "REDIS_URL"
    "QDRANT_URL"
    "MINIO_ENDPOINT"
  )

  [[ -f "$file" ]] || fail "${file} not found."

  for key in "${required_keys[@]}"; do
    local line value
    line=$(grep -E "^${key}=" "$file" | tail -1 || true)
    [[ -n "$line" ]] || fail "${file} is missing required key ${key}."
    value="${line#*=}"
    if [[ "$value" =~ ^\".*\"$ || "$value" =~ ^\'.*\'$ ]]; then
      fail "${file} contains quoted value for ${key}. Swarm env files must use unquoted values."
    fi
  done
}

preflight_browsergrid_arm64() {
  if [[ "$HOST_ARCH" != "arm64" ]]; then
    return
  fi

  info "Detected ARM64 host. Verifying linux/amd64 emulation for BrowserGrid..."

  docker run --rm --platform linux/amd64 alpine:3.20 uname -m >/dev/null 2>&1 || \
    fail "linux/amd64 emulation is not available. Enable Docker Desktop Rosetta/binfmt support or use an amd64 host."

  docker pull --platform linux/amd64 ghcr.io/danield2g/browsergrid-standalone:latest >/dev/null || \
    fail "Could not pull BrowserGrid for linux/amd64 emulation on this ARM64 host."

  ok "ARM64 emulation is available for BrowserGrid"
}

pull_stack_images() {
  if [[ "$HOST_ARCH" == "arm64" ]]; then
    docker compose -f "$INFRA_COMPOSE_FILE" pull postgres redis qdrant minio minio-init
    docker compose -f "$APP_COMPOSE_FILE" pull api web
    docker pull --platform linux/amd64 ghcr.io/danield2g/browsergrid-standalone:latest >/dev/null
    return
  fi

  docker compose -f "$INFRA_COMPOSE_FILE" pull
  docker compose -f "$APP_COMPOSE_FILE" pull
}

deploy_stack() {
  local stack_name="$1"
  local compose_file="$2"
  local resolve_mode="always"
  if [[ "$HOST_ARCH" == "arm64" && "$stack_name" == "$INFRA_STACK_NAME" ]]; then
    resolve_mode="never"
  fi

  docker stack deploy --resolve-image "$resolve_mode" -c "$compose_file" "$stack_name"
}

wait_for_shared_network() {
  local timeout=60
  local elapsed=0

  while [[ $elapsed -lt $timeout ]]; do
    if docker network inspect "$SHARED_NETWORK_NAME" >/dev/null 2>&1; then
      return
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done

  fail "Shared overlay network ${SHARED_NETWORK_NAME} was not created in time."
}

get_api_service_name() {
  printf '%s_api' "$APP_STACK_NAME"
}

# ── Banner ───────────────────────────────────────────

show_banner() {
  echo ""
  echo -e "${BOLD}${CYAN}"
  echo "  ╔══════════════════════════════════════════════╗"
  echo "  ║                                              ║"
  echo "  ║            ClawBuddy Setup Wizard           ║"
  echo "  ║                                              ║"
  echo "  ║   Self-hosted AI agent platform              ║"
  echo "  ║   with sandboxed tool execution              ║"
  echo "  ║                                              ║"
  echo "  ╚══════════════════════════════════════════════╝"
  echo -e "${NC}"
  echo -e "  This wizard will guide you through a Docker Swarm setup."
  echo -e "  It should take about ${BOLD}5 minutes${NC}."
  echo ""
}

# ── Step 1: Docker ───────────────────────────────────

step_docker_check() {
  step_header 1 "Docker"

  detect_os
  detect_host_arch
  info "Detected system: ${BOLD}$OS_TYPE${NC} (${BOLD}${HOST_ARCH}${NC})"

  # Check if Docker is installed
  if ! command -v docker &>/dev/null; then
    warn "Docker is not installed."
    echo ""

    case "$OS_TYPE" in
      linux-apt|wsl)
        if prompt_yes_no "Install Docker automatically via apt?" "y"; then
          info "Installing Docker..."
          sudo apt-get update -qq
          sudo apt-get install -y -qq docker.io docker-compose-plugin
          sudo systemctl enable --now docker
          sudo usermod -aG docker "$USER"
          ok "Docker installed"
          warn "You were added to the 'docker' group."
          warn "If you get permission errors, log out and back in, then re-run this script."
        else
          fail "Docker is required. Install it manually: https://docs.docker.com/engine/install/"
        fi
        ;;
      linux-dnf)
        if prompt_yes_no "Install Docker automatically via dnf?" "y"; then
          info "Installing Docker..."
          sudo dnf install -y dnf-plugins-core
          sudo dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo
          sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
          sudo systemctl enable --now docker
          sudo usermod -aG docker "$USER"
          ok "Docker installed"
          warn "You were added to the 'docker' group. Log out and back in if you get permission errors."
        else
          fail "Docker is required. Install it manually: https://docs.docker.com/engine/install/"
        fi
        ;;
      linux-yum)
        if prompt_yes_no "Install Docker automatically via yum?" "y"; then
          info "Installing Docker..."
          sudo yum install -y yum-utils
          sudo yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
          sudo yum install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
          sudo systemctl enable --now docker
          sudo usermod -aG docker "$USER"
          ok "Docker installed"
          warn "You were added to the 'docker' group. Log out and back in if you get permission errors."
        else
          fail "Docker is required. Install it manually: https://docs.docker.com/engine/install/"
        fi
        ;;
      macos)
        if command -v brew &>/dev/null; then
          if prompt_yes_no "Install Docker Desktop via Homebrew?" "y"; then
            info "Installing Docker Desktop..."
            brew install --cask docker
            echo ""
            echo -e "  ${YELLOW}Docker Desktop has been installed.${NC}"
            echo -e "  ${BOLD}Please open Docker Desktop from your Applications folder,${NC}"
            echo -e "  ${BOLD}wait for it to fully start, then re-run this script.${NC}"
            echo ""
            exit 0
          else
            fail "Docker is required. Download Docker Desktop: https://www.docker.com/products/docker-desktop/"
          fi
        else
          echo -e "  ${BOLD}To install Docker on macOS:${NC}"
          echo ""
          echo -e "    1. Download Docker Desktop from:"
          echo -e "       ${CYAN}https://www.docker.com/products/docker-desktop/${NC}"
          echo -e "    2. Open the .dmg and drag Docker to Applications"
          echo -e "    3. Open Docker Desktop and wait for it to start"
          echo -e "    4. Re-run this script"
          echo ""
          fail "Docker is required to continue."
        fi
        ;;
      linux-unknown)
        echo -e "  ${BOLD}Could not detect your package manager.${NC}"
        echo -e "  Install Docker manually: ${CYAN}https://docs.docker.com/engine/install/${NC}"
        fail "Docker is required to continue."
        ;;
      unsupported)
        echo -e "  ${BOLD}Unsupported operating system.${NC}"
        echo -e "  Install Docker manually: ${CYAN}https://docs.docker.com/engine/install/${NC}"
        fail "Docker is required to continue."
        ;;
    esac
  fi

  # Verify Docker is running
  if ! docker info &>/dev/null; then
    echo ""
    case "$OS_TYPE" in
      macos)
        echo -e "  ${BOLD}Docker is installed but not running.${NC}"
        echo -e "  Open ${CYAN}Docker Desktop${NC} from your Applications folder,"
        echo -e "  wait for it to fully start, then re-run this script."
        ;;
      *)
        echo -e "  ${BOLD}Docker is installed but not running.${NC}"
        echo -e "  Start it with: ${CYAN}sudo systemctl start docker${NC}"
        echo -e "  Then re-run this script."
        ;;
    esac
    fail "Docker daemon is not running."
  fi

  # Verify Docker Compose
  if ! docker compose version &>/dev/null; then
    echo ""
    echo -e "  ${BOLD}Docker Compose plugin is not installed.${NC}"
    echo -e "  Install it: ${CYAN}https://docs.docker.com/compose/install/${NC}"
    fail "Docker Compose is required to continue."
  fi

  ok "Docker $(docker --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  ok "Docker Compose $(docker compose version --short)"

  # Initialize Docker Swarm if not already active
  if ! docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null | grep -q "active"; then
    info "Initializing Docker Swarm..."
    docker swarm init 2>/dev/null || docker swarm init --advertise-addr 127.0.0.1
    ok "Docker Swarm initialized"
  else
    ok "Docker Swarm is active"
  fi

  preflight_browsergrid_arm64
}

# ── Step 2: Download & Pull ──────────────────────────

step_pull_images() {
  step_header 2 "Download & Pull Images"

  # Download files if not present
  if ! install_files_exist; then
    if [[ ! -f ".env" && ! -f "$LEGACY_COMPOSE_FILE" && ! -f "$INFRA_COMPOSE_FILE" && ! -f "$APP_COMPOSE_FILE" ]]; then
      mkdir -p ClawBuddy && cd ClawBuddy
    fi
    info "Downloading ${INFRA_COMPOSE_FILE}..."
    curl -fsSL "$RAW_BASE/${INFRA_COMPOSE_FILE}" -o "$INFRA_COMPOSE_FILE" || \
      fail "Could not download ${INFRA_COMPOSE_FILE}. Check your internet connection."
    info "Downloading ${APP_COMPOSE_FILE}..."
    curl -fsSL "$RAW_BASE/${APP_COMPOSE_FILE}" -o "$APP_COMPOSE_FILE" || \
      fail "Could not download ${APP_COMPOSE_FILE}. Check your internet connection."
    info "Downloading .env.example..."
    curl -fsSL "$RAW_BASE/.env.example" -o .env.example || \
      fail "Could not download .env.example. Check your internet connection."
    ok "Project files downloaded to $(pwd)"
  else
    ok "Stack files found in current directory"
  fi

  # Check ports (skip if our stack is already running)
  if ! is_any_stack_active; then
    info "Checking required ports..."
    local PORTS=(4321 4000 5433 6333 6334 6380 9000 9001 9090)
    local BUSY=()

    for port in "${PORTS[@]}"; do
      if lsof -iTCP:"$port" -sTCP:LISTEN -t &>/dev/null 2>&1; then
        BUSY+=("$port")
      fi
    done

    if [[ ${#BUSY[@]} -gt 0 ]]; then
      echo ""
      echo -e "  ${RED}The following ports are already in use: ${BOLD}${BUSY[*]}${NC}"
      echo ""
      echo -e "  ClawBuddy needs these ports:"
      echo -e "    4321 - Web app       4000 - API"
      echo -e "    5433 - PostgreSQL    6333 - Qdrant"
      echo -e "    6380 - Redis         9000 - MinIO"
      echo -e "    9001 - MinIO Console 9090 - BrowserGrid"
      echo ""
      echo -e "  To find what's using a port: ${CYAN}lsof -i :PORT${NC}"
      fail "Free the ports listed above and re-run this script."
    fi
    ok "All required ports are free"
  else
    ok "Stack already running, skipping port check"
  fi

  # Pull images
  info "Pulling Docker images (this may take a few minutes on first run)..."
  echo ""
  pull_stack_images
  echo ""
  ok "All images pulled"
}

# ── API Key Collection Helpers ─────────────────────

collect_openai_key() {
  show_guide "How to get an OpenAI API key:" \
    "1. Go to: ${CYAN}https://platform.openai.com/api-keys${NC}" \
    "2. Sign up or log in" \
    "3. Click ${BOLD}Create new secret key${NC}" \
    "4. Name it (e.g., clawbuddy)" \
    "5. Copy the key (starts with ${BOLD}sk-...${NC})"

  prompt_api_key "OpenAI" "^sk-" "Key should start with sk-" OPENAI_KEY
  echo ""
}

collect_anthropic_key() {
  show_guide "How to get an Anthropic API key:" \
    "1. Go to: ${CYAN}https://console.anthropic.com${NC}" \
    "2. Sign up or log in" \
    "3. Navigate to ${BOLD}API Keys${NC} in the sidebar" \
    "4. Click ${BOLD}Create Key${NC}" \
    "5. Copy the key (starts with ${BOLD}sk-ant-...${NC})"

  prompt_api_key "Anthropic" "^sk-ant-" "Key should start with sk-ant-" ANTHROPIC_KEY
  echo ""
}

collect_gemini_key() {
  show_guide "How to get a Google Gemini API key:" \
    "1. Go to: ${CYAN}https://aistudio.google.com${NC}" \
    "2. Sign in with your Google account" \
    "3. Click ${BOLD}Get API key${NC} in the sidebar" \
    "4. Click ${BOLD}Create API key${NC}" \
    "5. Copy the key (starts with ${BOLD}AIza...${NC})"

  prompt_api_key "Gemini" "^AIza" "Key should start with AIza" GEMINI_KEY
  echo ""
}

collect_local_base_url() {
  echo -e "  ${BOLD}Configure your local OpenAI-compatible endpoint:${NC}"
  echo -e "  ${DIM}Examples:${NC}"
  echo -e "    LM Studio: ${CYAN}http://127.0.0.1:1234/v1${NC}"
  echo -e "    Ollama:    ${CYAN}http://127.0.0.1:11434/v1${NC}"
  echo ""

  while true; do
    read_input "Local provider base URL:" LOCAL_PROVIDER_BASE_URL
    if [[ "$LOCAL_PROVIDER_BASE_URL" =~ ^https?://.+/v1/?$ ]]; then
      ok "Local provider base URL set"
      echo ""
      return
    fi
    echo -e "  ${RED}Please enter a full OpenAI-compatible base URL ending in /v1${NC}"
  done
}

# ── Step 3: Provider Connections ────────────────────

step_api_keys() {
  step_header 3 "AI Provider Configuration"

  # Check for existing .env
  if [[ -f .env ]]; then
    echo -e "  An existing ${BOLD}.env${NC} configuration was found."
    echo ""
    if ! prompt_yes_no "Do you want to reconfigure your AI providers?" "n"; then
      SKIP_API_SETUP=true
      ok "Keeping existing configuration"
      return
    fi
    echo ""
  fi

  # ── Choose AI Provider ──
  echo -e "  ${BOLD}Choose your AI provider for chat:${NC}"
  echo ""
  prompt_choice "Which AI provider do you want to use?" \
    "OpenAI    - GPT-5.4, GPT-5, GPT-4.1, O3" \
    "Gemini    - Gemini 3.1 Pro, 3 Flash, 2.5 Pro" \
    "Claude    - Opus 4.6, Sonnet 4.6, Haiku 4.5" \
    "Local     - LM Studio or Ollama via OpenAI-compatible /v1"

  local providers=("openai" "gemini" "claude" "local")
  AI_PROVIDER="${providers[$MENU_RESULT]}"
  ok "AI provider: ${BOLD}$AI_PROVIDER${NC}"
  echo ""

  # ── Choose Embedding Provider ──
  if [[ "$AI_PROVIDER" == "claude" ]]; then
    echo -e "  ${YELLOW}Note:${NC} Claude does not provide an embeddings API."
    echo -e "  You need either ${BOLD}OpenAI${NC} or ${BOLD}Gemini${NC} for embeddings."
    echo ""
  fi

  prompt_choice "Which provider for embeddings?" \
    "OpenAI  - text-embedding-3-small/large" \
    "Gemini  - gemini-embedding-001/002" \
    "Local   - Local OpenAI-compatible embeddings endpoint"

  local embed_providers=("openai" "gemini" "local")
  EMBEDDING_PROVIDER="${embed_providers[$MENU_RESULT]}"
  ok "Embedding provider: ${BOLD}$EMBEDDING_PROVIDER${NC}"
  echo ""

  # ── Determine which connections we need ──
  local need_openai=false
  local need_anthropic=false
  local need_gemini=false
  local need_local=false

  [[ "$AI_PROVIDER" == "openai" || "$EMBEDDING_PROVIDER" == "openai" ]] && need_openai=true
  [[ "$AI_PROVIDER" == "claude" ]] && need_anthropic=true
  [[ "$AI_PROVIDER" == "gemini" || "$EMBEDDING_PROVIDER" == "gemini" ]] && need_gemini=true
  [[ "$AI_PROVIDER" == "local" || "$EMBEDDING_PROVIDER" == "local" ]] && need_local=true

  # ── Collect required connections ──
  if [[ "$need_openai" == true ]]; then
    collect_openai_key
  fi

  if [[ "$need_anthropic" == true ]]; then
    collect_anthropic_key
  fi

  if [[ "$need_gemini" == true ]]; then
    collect_gemini_key
  fi

  if [[ "$need_local" == true ]]; then
    collect_local_base_url
  fi

  # ── Optional: Additional provider keys ──
  local extra_providers=()
  [[ "$need_openai" == false ]]    && extra_providers+=("openai")
  [[ "$need_anthropic" == false ]] && extra_providers+=("anthropic")
  [[ "$need_gemini" == false ]]    && extra_providers+=("gemini")

  if [[ ${#extra_providers[@]} -gt 0 ]]; then
    echo ""
    echo -e "  ${BOLD}Optional: Additional AI Provider Keys${NC}"
    echo -e "  ${DIM}You can add keys for other providers now, or add them later in .env${NC}"
    echo ""

    if prompt_yes_no "Configure additional provider keys?" "n"; then
      for provider in "${extra_providers[@]}"; do
        case "$provider" in
          openai)    collect_openai_key ;;
          anthropic) collect_anthropic_key ;;
          gemini)    collect_gemini_key ;;
        esac
      done
    fi
  fi

  # ── Validate we have at least the embedding connection ──
  local has_embedding_key=false
  if [[ "$EMBEDDING_PROVIDER" == "openai" && -n "$OPENAI_KEY" ]]; then
    has_embedding_key=true
  elif [[ "$EMBEDDING_PROVIDER" == "gemini" && -n "$GEMINI_KEY" ]]; then
    has_embedding_key=true
  elif [[ "$EMBEDDING_PROVIDER" == "local" && -n "${LOCAL_PROVIDER_BASE_URL:-}" ]]; then
    has_embedding_key=true
  fi

  if [[ "$has_embedding_key" == false ]]; then
    warn "You skipped the connection details for your embedding provider ($EMBEDDING_PROVIDER)."
    warn "Embeddings are required for document search to work."
    warn "You can add the connection later by editing the .env file."
  fi

  # ── Optional: Google OAuth ──
  echo ""
  echo -e "  ${BOLD}Optional: Google Workspace Integration${NC}"
  echo -e "  ${DIM}Enables Gmail, Calendar, and Drive access for the AI agent.${NC}"
  echo ""

  if prompt_yes_no "Set up Google Workspace integration?" "n"; then
    echo ""
    show_guide "Google OAuth Setup:" \
      "1. Go to: ${CYAN}https://console.cloud.google.com${NC}" \
      "2. Create a new project (e.g., 'ClawBuddy')" \
      "3. Go to ${BOLD}APIs & Services > Library${NC} and enable:" \
      "   - Gmail API" \
      "   - Google Calendar API" \
      "   - Google Drive API" \
      "4. Go to ${BOLD}APIs & Services > OAuth consent screen${NC}" \
      "   - Select External, fill in app name and emails" \
      "   - Add scopes: mail, calendar, drive, userinfo.email" \
      "   - Add your email as a test user" \
      "5. Go to ${BOLD}APIs & Services > Credentials${NC}" \
      "   - Create Credentials > OAuth client ID" \
      "   - Type: Web application" \
      "   - Redirect URI: http://localhost:4321/api/oauth/google/callback" \
      "6. Copy the ${BOLD}Client ID${NC} and ${BOLD}Client Secret${NC}"

    echo ""
    read_input "Paste your Google Client ID:" GOOGLE_CLIENT_ID
    if [[ -n "$GOOGLE_CLIENT_ID" ]]; then
      read_input "Paste your Google Client Secret:" GOOGLE_CLIENT_SECRET
      ok "Google OAuth configured"

      echo ""
      echo -e "  ${DIM}If ClawBuddy will NOT run on localhost:4321, enter your URL below.${NC}"
      echo -e "  ${DIM}Otherwise just press Enter to skip.${NC}"
      read_input "App URL (e.g., https://your-domain.com):" APP_URL
    fi
  fi
}

# ── Step 4: Generate .env ────────────────────────────

step_generate_env() {
  step_header 4 "Generate Configuration"

  if [[ "$SKIP_API_SETUP" == true ]]; then
    normalize_env_file .env

    # Just ensure ENCRYPTION_SECRET is set
    if grep -q "change-me-to-a-random-secret" .env 2>/dev/null; then
      local secret
      secret=$(openssl rand -base64 32)
      set_env_var "ENCRYPTION_SECRET" "$secret"
      ok "Generated ENCRYPTION_SECRET"
    fi
    validate_stack_env_file .env
    ok "Using existing .env configuration"
    return
  fi

  # Start from .env.example
  if [[ -f .env.example ]]; then
    cp .env.example .env
    normalize_env_file .env
  else
    fail ".env.example not found. Cannot generate configuration."
  fi

  # Set AI providers
  set_env_var "AI_PROVIDER" "$AI_PROVIDER"
  set_env_var "EMBEDDING_PROVIDER" "$EMBEDDING_PROVIDER"

  # Set API keys
  [[ -n "$OPENAI_KEY" ]]       && set_env_var "OPENAI_API_KEY" "$OPENAI_KEY"
  [[ -n "$ANTHROPIC_KEY" ]]    && set_env_var "ANTHROPIC_API_KEY" "$ANTHROPIC_KEY"
  [[ -n "$GEMINI_KEY" ]]       && set_env_var "GEMINI_API_KEY" "$GEMINI_KEY"
  [[ -n "${LOCAL_PROVIDER_BASE_URL:-}" ]] && set_env_var "LOCAL_PROVIDER_BASE_URL" "$LOCAL_PROVIDER_BASE_URL"
  [[ -n "${GOOGLE_CLIENT_ID:-}" ]] && set_env_var "GOOGLE_CLIENT_ID" "$GOOGLE_CLIENT_ID"
  [[ -n "${GOOGLE_CLIENT_SECRET:-}" ]] && set_env_var "GOOGLE_CLIENT_SECRET" "$GOOGLE_CLIENT_SECRET"
  [[ -n "${APP_URL:-}" ]]          && set_env_var "APP_URL" "$APP_URL"

  # Generate ENCRYPTION_SECRET
  local secret
  secret=$(openssl rand -base64 32)
  set_env_var "ENCRYPTION_SECRET" "$secret"

  validate_stack_env_file .env

  ok "Configuration saved to .env"
  echo ""

  # Summary
  echo -e "  ${BOLD}Configuration Summary:${NC}"
  echo -e "    AI Provider:        ${CYAN}$AI_PROVIDER${NC}"
  echo -e "    Embedding Provider: ${CYAN}$EMBEDDING_PROVIDER${NC}"
  [[ -n "$OPENAI_KEY" ]]       && echo -e "    OpenAI Key:         ${GREEN}set${NC}"
  [[ -n "$ANTHROPIC_KEY" ]]    && echo -e "    Anthropic Key:      ${GREEN}set${NC}"
  [[ -n "$GEMINI_KEY" ]]       && echo -e "    Gemini Key:         ${GREEN}set${NC}"
  [[ -n "${LOCAL_PROVIDER_BASE_URL:-}" ]] && echo -e "    Local Base URL:     ${CYAN}$LOCAL_PROVIDER_BASE_URL${NC}"
  [[ -n "${GOOGLE_CLIENT_ID:-}" ]] && echo -e "    Google OAuth:       ${GREEN}configured${NC}"
  [[ -n "${APP_URL:-}" ]]          && echo -e "    App URL:            ${CYAN}$APP_URL${NC}"
  echo ""
}

# ── Step 5: Start Services ───────────────────────────

step_start_services() {
  step_header 5 "Start Services"

  validate_stack_env_file .env

  info "Deploying infrastructure stack..."
  deploy_stack "$INFRA_STACK_NAME" "$INFRA_COMPOSE_FILE"
  wait_for_shared_network
  echo ""

  info "Deploying application stack..."
  deploy_stack "$APP_STACK_NAME" "$APP_COMPOSE_FILE"
  echo ""

  info "Waiting for API to become healthy..."
  local timeout=180
  local elapsed=0
  local api_service_name
  api_service_name=$(get_api_service_name)

  while [[ $elapsed -lt $timeout ]]; do
    local container_id
    container_id=$(docker ps --filter "label=com.docker.swarm.service.name=${api_service_name}" --format "{{.ID}}" 2>/dev/null | head -1 || true)
    if [[ -n "$container_id" ]]; then
      local health
      health=$(docker inspect --format='{{.State.Health.Status}}' "$container_id" 2>/dev/null || true)
      if [[ "$health" == "healthy" ]]; then
        break
      fi
    fi
    sleep 5
    elapsed=$((elapsed + 5))
    echo -ne "\r  Waiting... ${elapsed}s / ${timeout}s"
  done
  echo -ne "\r                              \r"

  if [[ $elapsed -ge $timeout ]]; then
    warn "API did not become healthy within ${timeout}s."
    echo ""
    echo -e "  This might just need more time. You can check with:"
    echo -e "    ${CYAN}docker stack services ${INFRA_STACK_NAME}${NC}  - see infrastructure status"
    echo -e "    ${CYAN}docker stack services ${APP_STACK_NAME}${NC}    - see application status"
    echo -e "    ${CYAN}docker service logs ${api_service_name}${NC}  - see API logs"
    echo ""
  else
    ok "All services are healthy"
  fi

  # Success banner
  echo ""
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${GREEN}${BOLD}  ClawBuddy is running!${NC}"
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  echo -e "  ${BOLD}Open in your browser:${NC}"
  echo -e "    ${CYAN}http://localhost:4321${NC}"
  echo ""
  echo -e "  ${BOLD}Useful commands:${NC}"
  echo -e "    ${DIM}View logs:${NC}    docker service logs ${api_service_name} -f"
  echo -e "    ${DIM}Stop:${NC}         docker stack rm ${APP_STACK_NAME} ${INFRA_STACK_NAME}"
  echo -e "    ${DIM}Restart:${NC}      docker service update --force ${api_service_name}"
  echo -e "    ${DIM}Infra:${NC}        docker stack services ${INFRA_STACK_NAME}"
  echo -e "    ${DIM}App:${NC}          docker stack services ${APP_STACK_NAME}"
  echo -e "    ${DIM}Update:${NC}       bash bootstrap.sh --update"
  echo ""
  echo -e "  ${BOLD}Other services:${NC}"
  echo -e "    API:            ${CYAN}http://localhost:4000${NC}"
  echo -e "    MinIO Console:  ${CYAN}http://localhost:9001${NC}"
  echo ""
}

# ── Update Function ──────────────────────────────────

do_update() {
  echo ""
  echo -e "${BOLD}${CYAN}━━━ ClawBuddy Update ━━━${NC}"
  echo ""

  detect_os
  detect_host_arch

  command -v docker &>/dev/null || fail "Docker is required to run updates."
  docker info &>/dev/null || fail "Docker daemon is not running."
  docker compose version &>/dev/null || fail "Docker Compose plugin is required to detect legacy installs."
  docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null | grep -q "active" || \
    fail "Docker Swarm must be active to update this installation."

  preflight_browsergrid_arm64

  # Find installation
  if install_files_exist || [[ -f "$LEGACY_COMPOSE_FILE" ]]; then
    : # we're in the right directory
  elif [[ -f "ClawBuddy/${INFRA_COMPOSE_FILE}" || -f "ClawBuddy/${APP_COMPOSE_FILE}" || -f "ClawBuddy/${LEGACY_COMPOSE_FILE}" ]]; then
    cd ClawBuddy
  else
    fail "No ClawBuddy installation found. Run this script without --update to install."
  fi

  if has_legacy_compose_installation && ! is_any_stack_active; then
    fail "This version does not migrate Docker Compose installations to Swarm automatically. Do a clean install or perform the migration manually first."
  fi

  if ! is_stack_active "$INFRA_STACK_NAME"; then
    fail "No active ClawBuddy infrastructure stack found. --update only supports existing Swarm installations."
  fi

  if [[ ! -f ".env" ]]; then
    fail "No .env configuration found. --update requires an existing Swarm installation."
  fi

  normalize_env_file .env
  validate_stack_env_file .env

  # Backup current stack files
  [[ -f "$INFRA_COMPOSE_FILE" ]] && cp "$INFRA_COMPOSE_FILE" "${INFRA_COMPOSE_FILE}.bak"
  [[ -f "$APP_COMPOSE_FILE" ]] && cp "$APP_COMPOSE_FILE" "${APP_COMPOSE_FILE}.bak"
  ok "Backed up stack files"

  # Download latest stack files
  info "Downloading latest ${INFRA_COMPOSE_FILE}..."
  curl -fsSL "$RAW_BASE/${INFRA_COMPOSE_FILE}" -o "$INFRA_COMPOSE_FILE" || {
    warn "Could not download latest ${INFRA_COMPOSE_FILE}. Restoring backup."
    [[ -f "${INFRA_COMPOSE_FILE}.bak" ]] && mv "${INFRA_COMPOSE_FILE}.bak" "$INFRA_COMPOSE_FILE"
    [[ -f "${APP_COMPOSE_FILE}.bak" ]] && mv "${APP_COMPOSE_FILE}.bak" "$APP_COMPOSE_FILE"
    fail "Update failed. Check your internet connection."
  }
  info "Downloading latest ${APP_COMPOSE_FILE}..."
  curl -fsSL "$RAW_BASE/${APP_COMPOSE_FILE}" -o "$APP_COMPOSE_FILE" || {
    warn "Could not download latest ${APP_COMPOSE_FILE}. Restoring backup."
    [[ -f "${INFRA_COMPOSE_FILE}.bak" ]] && mv "${INFRA_COMPOSE_FILE}.bak" "$INFRA_COMPOSE_FILE"
    [[ -f "${APP_COMPOSE_FILE}.bak" ]] && mv "${APP_COMPOSE_FILE}.bak" "$APP_COMPOSE_FILE"
    fail "Update failed. Check your internet connection."
  }
  ok "Stack files updated"

  info "Refreshing stack images..."
  echo ""
  pull_stack_images
  echo ""
  ok "Images updated"

  # Deploy updated stacks
  info "Deploying updated infrastructure stack..."
  deploy_stack "$INFRA_STACK_NAME" "$INFRA_COMPOSE_FILE"
  wait_for_shared_network
  echo ""

  info "Deploying updated application stack..."
  deploy_stack "$APP_STACK_NAME" "$APP_COMPOSE_FILE"
  echo ""

  # Wait for health
  info "Waiting for API to become healthy..."
  local timeout=180
  local elapsed=0
  local api_service_name
  api_service_name=$(get_api_service_name)

  while [[ $elapsed -lt $timeout ]]; do
    local container_id
    container_id=$(docker ps --filter "label=com.docker.swarm.service.name=${api_service_name}" --format "{{.ID}}" 2>/dev/null | head -1 || true)
    if [[ -n "$container_id" ]]; then
      local health
      health=$(docker inspect --format='{{.State.Health.Status}}' "$container_id" 2>/dev/null || true)
      if [[ "$health" == "healthy" ]]; then
        break
      fi
    fi
    sleep 5
    elapsed=$((elapsed + 5))
    echo -ne "\r  Waiting... ${elapsed}s / ${timeout}s"
  done
  echo -ne "\r                              \r"

  if [[ $elapsed -ge $timeout ]]; then
    warn "API did not become healthy within ${timeout}s."
    echo -e "  Check logs: ${CYAN}docker service logs ${api_service_name}${NC}"
  else
    ok "API is healthy"
  fi

  rm -f "${INFRA_COMPOSE_FILE}.bak" "${APP_COMPOSE_FILE}.bak"

  # Check for migration script
  info "Checking for migration scripts..."
  local update_script
  update_script=$(curl -fsSL "$RAW_BASE/scripts/update.sh" 2>/dev/null || true)
  if [[ -n "$update_script" ]]; then
    info "Running migration script..."
    bash <(echo "$update_script")
    ok "Migrations complete"
  else
    ok "No migrations needed"
  fi

  # Done
  echo ""
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${GREEN}${BOLD}  ClawBuddy has been updated!${NC}"
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  echo -e "  ${BOLD}Open in your browser:${NC}"
  echo -e "    ${CYAN}http://localhost:4321${NC}"
  echo ""
  echo -e "  ${BOLD}Useful commands:${NC}"
  echo -e "    ${DIM}View logs:${NC}    docker service logs ${api_service_name} -f"
  echo -e "    ${DIM}Infra:${NC}        docker stack services ${INFRA_STACK_NAME}"
  echo -e "    ${DIM}App:${NC}          docker stack services ${APP_STACK_NAME}"
  echo ""
}

# ── Main ─────────────────────────────────────────────

main() {
  # Parse arguments
  case "${1:-}" in
    --update|-u)
      do_update
      exit 0
      ;;
    --help|-h)
      echo "Usage: bootstrap.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --update, -u    Update an existing ClawBuddy Swarm installation"
      echo "  --help, -h      Show this help message"
      echo ""
      echo "Run without arguments for a first-time Docker Swarm setup."
      exit 0
      ;;
  esac

  show_banner

  step_docker_check
  step_pull_images
  step_api_keys
  step_generate_env
  step_start_services
}

main "$@"
