.PHONY: install dev build lint format type-check clean \
       docker-up docker-down docker-restart docker-logs \
       db-generate db-push db-migrate db-studio \
       setup start stop

# ─── Quick Start ───────────────────────────────────────────

setup: install docker-up db-generate db-push ## First-time setup: install deps, start infra, init DB
	@echo "✅ Setup complete. Run 'make dev' to start."

start: docker-up dev ## Start everything (infra + dev servers)

stop: docker-down ## Stop all infrastructure services

# ─── Development ───────────────────────────────────────────

install: ## Install all dependencies
	bun install

SHELL := /bin/bash
dev: ## Start dev servers (web + api), agent debug logs → logs/agent-debug.log
	@mkdir -p logs
	DEBUG_AGENT=1 bun run dev 2>&1 | tee -a logs/dev.log

build: ## Build all packages
	bun run build

lint: ## Run linters
	bun run lint

format: ## Format all files
	bun run format

format-check: ## Check formatting
	bun run format:check

type-check: ## Run TypeScript type checking
	bun run type-check

clean: ## Remove node_modules, dist, .turbo
	bun run clean

# ─── Docker / Infrastructure ──────────────────────────────

DEV_COMPOSE := docker compose -f docker-compose.dev.yml

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
	bun run db:generate

db-push: ## Push schema to database
	bun run db:push

db-migrate: ## Run Prisma migrations
	cd apps/api && bun run db:migrate

db-studio: ## Open Prisma Studio
	cd apps/api && bun run db:studio

# ─── Sandbox Images ──────────────────────────────────────

build-sandbox-images: ## Build all sandbox Docker images
	docker build -t clawbuddy-sandbox-base apps/api/sandbox-images/base/
	docker build -t clawbuddy-sandbox-python apps/api/sandbox-images/python/
	docker build -t clawbuddy-sandbox-aws apps/api/sandbox-images/aws-cli/
	docker build -t clawbuddy-sandbox-kubectl apps/api/sandbox-images/kubectl/
	docker build -t clawbuddy-sandbox-node apps/api/sandbox-images/node/
	docker build -t clawbuddy-sandbox-full apps/api/sandbox-images/full/

# ─── Help ─────────────────────────────────────────────────

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-16s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
