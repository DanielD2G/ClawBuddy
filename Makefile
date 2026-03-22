.PHONY: dev dev-build infra test lint fmt format typecheck clean \
       docker-down docker-restart docker-logs docker-reset \
       api api-worker api-test api-lint api-fmt api-typecheck \
       web web-lint web-fmt \
       db-migrate db-upgrade db-downgrade \
       setup stop help

SHELL := /bin/bash
DEV_COMPOSE := docker compose -f docker-compose.dev.yml

# ─── Quick Start ───────────────────────────────────────────

setup: infra ## First-time setup: start infra, install API deps
	cd backend && uv sync
	cd frontend && bun install
	@echo "Setup complete. Run 'make infra', then 'make api' and 'make web' in separate terminals."

stop: docker-down ## Stop all containers

# ─── Infrastructure ───────────────────────────────────────

infra: ## Start infrastructure (Postgres, Redis, Qdrant, MinIO, BrowserGrid)
	$(DEV_COMPOSE) --profile infra up -d

# ─── Full Stack (Docker Compose) ──────────────────────────

dev: ## Start full dev stack in Docker Compose (API + Web + Infra)
	$(DEV_COMPOSE) --profile app up --build

dev-build: ## Force rebuild and start dev stack
	$(DEV_COMPOSE) --profile app up --build --force-recreate

# ─── API (Python/FastAPI) ─────────────────────────────────

api: ## Run API server locally (requires infra)
	cd backend && uv run uvicorn clawbuddy.main:app --host 0.0.0.0 --port 4000 --reload --reload-dir src

api-worker: ## Run ARQ worker locally
	cd backend && uv run arq clawbuddy.workers.WorkerSettings

api-test: ## Run API tests
	cd backend && uv run pytest tests/ -v

api-lint: ## Lint API code with ruff
	cd backend && uv run ruff check src/

api-fmt: ## Format API code with ruff
	cd backend && uv run ruff format src/

api-typecheck: ## Type-check API code with mypy
	cd backend && uv run mypy src/

# ─── Web (React/Vite) ─────────────────────────────────────

web: ## Run web dev server locally (requires API)
	cd frontend && bun run dev

web-lint: ## Lint web code
	cd frontend && bun run lint

web-fmt: ## Format web code
	cd frontend && bun run fmt

# ─── Combined Commands ────────────────────────────────────

test: api-test ## Run test suite

lint: api-lint ## Run linters

fmt: api-fmt ## Format code

format: fmt ## Alias for fmt

typecheck: api-typecheck ## Type-check code

clean: ## Remove build artifacts
	rm -rf backend/.venv backend/__pycache__ backend/src/**/__pycache__
	rm -rf frontend/dist frontend/node_modules

# ─── Docker ──────────────────────────────────────────────

docker-down: ## Stop all containers
	$(DEV_COMPOSE) down

docker-restart: ## Restart infrastructure
	$(DEV_COMPOSE) down && $(DEV_COMPOSE) --profile infra up -d

docker-logs: ## Tail container logs
	$(DEV_COMPOSE) logs -f

docker-reset: ## Stop containers and remove volumes (destroys data)
	$(DEV_COMPOSE) down -v

# ─── Database (Alembic) ──────────────────────────────────

db-migrate: ## Create a new Alembic migration (usage: make db-migrate msg="description")
	cd backend && uv run alembic revision --autogenerate -m "$(msg)"

db-upgrade: ## Apply pending migrations
	cd backend && uv run alembic upgrade head

db-downgrade: ## Revert last migration
	cd backend && uv run alembic downgrade -1

# ─── Help ─────────────────────────────────────────────────

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-18s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
