.PHONY: install dev dev-build build test lint fmt format format-check type-check typecheck clean \
       docker-up docker-down docker-restart docker-logs \
       db-generate db-push db-migrate db-studio \
       setup start stop

# ─── Quick Start ───────────────────────────────────────────

setup: install docker-up db-generate db-push ## First-time setup: install deps, start infra, init DB
	@echo "✅ Setup complete. Run 'make dev' to start."

start: dev ## Start everything (infra + dev servers)

stop: docker-down ## Stop all infrastructure services

# ─── Development ───────────────────────────────────────────

install: ## Install all dependencies
	$(COMPOSE_WORKSPACE) true

SHELL := /bin/bash
dev: ## Start development stack in Docker Compose with live reload
	$(DEV_COMPOSE) --profile app up

dev-build: ## Build and start development stack in Docker Compose
	$(DEV_COMPOSE) --profile app up --build

build: ## Build all packages
	$(COMPOSE_WORKSPACE) bun run build

test: ## Run the full test suite in Docker Compose
	$(COMPOSE_TEST)

lint: ## Run linters
	$(COMPOSE_WORKSPACE) bun lint

fmt: ## Format all files
	$(COMPOSE_WORKSPACE) bun fmt

format: fmt ## Format all files

format-check: ## Check formatting
	$(COMPOSE_WORKSPACE) bun run format:check

type-check: ## Run TypeScript type checking
	$(COMPOSE_WORKSPACE) sh -lc "bun run db:generate && bun type-check"

typecheck: type-check ## Run TypeScript type checking

clean: ## Remove node_modules, dist, .turbo
	$(COMPOSE_WORKSPACE) bun run clean

# ─── Docker / Infrastructure ──────────────────────────────

DEV_COMPOSE := docker compose -f docker-compose.dev.yml
COMPOSE_WORKSPACE := $(DEV_COMPOSE) run --rm --no-deps workspace
COMPOSE_API := $(DEV_COMPOSE) run --rm api
COMPOSE_API_PORTS := $(DEV_COMPOSE) run --rm --service-ports api
COMPOSE_TEST := $(DEV_COMPOSE) run --rm test

docker-up: ## Start infrastructure (Postgres, Redis, Qdrant, MinIO, BrowserGrid)
	$(DEV_COMPOSE) --profile infra up -d

docker-down: ## Stop all containers
	$(DEV_COMPOSE) down

docker-restart: docker-down docker-up ## Restart all containers

docker-logs: ## Tail container logs
	$(DEV_COMPOSE) logs -f

docker-reset: ## Stop containers and remove volumes (⚠️ destroys data)
	$(DEV_COMPOSE) down -v

# ─── Database ─────────────────────────────────────────────

db-generate: ## Generate Prisma client
	$(COMPOSE_WORKSPACE) bun run db:generate

db-push: ## Push schema to database
	$(COMPOSE_API) sh -lc "cd apps/api && bun run db:push"

db-migrate: ## Run Prisma migrations
	$(COMPOSE_API_PORTS) sh -lc "cd apps/api && bun run db:migrate"

db-studio: ## Open Prisma Studio
	$(DEV_COMPOSE) run --rm --service-ports -p 5555:5555 api sh -lc "cd apps/api && bun x prisma studio --hostname 0.0.0.0 --port 5555"

# ─── Help ─────────────────────────────────────────────────

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-16s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
