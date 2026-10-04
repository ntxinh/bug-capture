.PHONY: install build test test-unit test-e2e lint format typecheck clean

install:
	bun install

build:
	cd apps/extension && bun run build

test: build test-unit

test-unit:
	cd apps/extension && bun test test/
	bun test packages/

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
