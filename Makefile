.PHONY: install build test test-unit test-api test-e2e lint format typecheck clean db-up db-down db-migrate db-generate dev-api

install:
	bun install

build:
	cd apps/extension && bun run build

test: build test-unit

test-unit:
	cd apps/extension && bun test test/
	bun test packages/

test-api:
	bun test apps/api/test/

test-e2e:
	cd apps/extension && bunx playwright test

lint:
	bunx biome check .

format:
	bunx biome format --write .

typecheck:
	bun run --filter '*' check-types

clean:
	find . \( -name node_modules -o -name dist -o -name .turbo -o -name coverage \) -type d -prune -exec rm -rf {} +

db-up:
	podman compose up -d postgres 2>/dev/null || docker compose up -d postgres

db-down:
	podman compose down 2>/dev/null || docker compose down

db-migrate:
	cd packages/db && bun run --bun -e "import('./src/migrate.ts').then(m=>m.migrate(process.env.DATABASE_URL ?? 'postgres://bugcapture:dev@localhost:5432/bugcapture'))"

db-generate:
	cd packages/db && bunx drizzle-kit generate

dev-api:
	cd apps/api && bun run dev
