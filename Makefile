.PHONY: install build lint test typecheck run-api run-proxy

install:
	npm install

build:
	npm run build

lint:
	npm run lint

typecheck:
	npm run typecheck

test:
	npm test

run-api:
	npm run dev:api

run-proxy:
	npm run dev:proxy
