# revendo — one-command demo.
#
# The only prerequisite is Docker with Compose v2. No Node, no JDK, no API keys,
# no network egress beyond pulling base images.
#
# Start with:  make demo

SHELL := /bin/bash
.DEFAULT_GOAL := help

COMPOSE := docker compose
RUN_WORKER = $(COMPOSE) run --rm -T

# ANSI, defined once. Terminals that do not understand them are rare enough that
# the alternative — no visual structure at all — is the worse default.
BOLD  := \033[1m
DIM   := \033[2m
CYAN  := \033[36m
GREEN := \033[32m
AMBER := \033[33m
RED   := \033[31m
OFF   := \033[0m

.PHONY: help demo demo-raw demo-naive demo-stealth up up-fleet down clean logs reset \
        scoreboard console screenshot test test-worker test-site test-control build ps

help: ## Show this help
	@printf "$(BOLD)$(CYAN)revendo$(OFF) — a scraping control plane and the anti-bot system it has to beat\n\n"
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(BOLD)%-14s$(OFF) %s\n", $$1, $$2}'
	@printf "\n  $(DIM)Start with: make demo$(OFF)\n\n"

# -----------------------------------------------------------------------------
# The demo
# -----------------------------------------------------------------------------

demo: build up reset ## Run all three profiles against the same detector and compare
	@printf "\n$(BOLD)$(CYAN)══ revendo ═══════════════════════════════════════════════════$(OFF)\n"
	@printf "  Three clients. One marketplace. One detector.\n"
	@printf "  $(DIM)Watch it live: http://localhost:8080/__sentinelle$(OFF)\n"
	@printf "$(BOLD)$(CYAN)══════════════════════════════════════════════════════════════$(OFF)\n"
	@$(MAKE) --no-print-directory demo-raw
	@$(MAKE) --no-print-directory demo-naive
	@$(MAKE) --no-print-directory demo-stealth
	@$(MAKE) --no-print-directory scoreboard

demo-raw: ## Baseline: plain HTTP requests, no browser at all
	@printf "\n$(BOLD)[1/3] raw-http$(OFF) $(DIM)— what most people mean by \"a scraper\"$(OFF)\n"
	@printf "$(DIM)      No browser. Everything is decided before a line of JavaScript runs.$(OFF)\n"
	@PROFILE=raw-http $(RUN_WORKER) worker node dist/cli.js || true

demo-naive: ## Headless Chrome with no countermeasures — the control
	@printf "\n$(BOLD)[2/3] naive$(OFF) $(DIM)— real Chrome over CDP, element.click(), no stealth$(OFF)\n"
	@printf "$(DIM)      Same flow as the stealth run. Only the physics differ.$(OFF)\n"
	@PROFILE=naive $(RUN_WORKER) worker node dist/cli.js || true

demo-stealth: ## Full stealth: fingerprint patches + human behaviour emulation
	@printf "\n$(BOLD)[3/3] stealth$(OFF) $(DIM)— coherent identity, laundered natives, Fitts-timed pointer$(OFF)\n"
	@printf "$(DIM)      This one takes ~70s. That is the point: patience is the countermeasure.$(OFF)\n"
	@PROFILE=stealth $(RUN_WORKER) worker node dist/cli.js || true

scoreboard: ## Print what Sentinelle made of every session so far
	@$(COMPOSE) exec -T target-site node -e "$$SCOREBOARD_JS" 2>/dev/null \
	  || printf "$(AMBER)  (target-site not running — try: make up)$(OFF)\n"

# -----------------------------------------------------------------------------
# Lifecycle
# -----------------------------------------------------------------------------

build: ## Build all images
	@printf "$(DIM)building images (first run pulls Chromium and a JDK — a few minutes)$(OFF)\n"
	@$(COMPOSE) build

up: ## Start Redis, RabbitMQ, Vitrine and the control plane
	@$(COMPOSE) up -d redis rabbitmq target-site control-plane
	@printf "$(GREEN)✓$(OFF) marketplace   http://localhost:8080\n"
	@printf "$(GREEN)✓$(OFF) console       http://localhost:8080/__sentinelle\n"
	@printf "$(GREEN)✓$(OFF) control plane http://localhost:8081/listings\n"
	@printf "$(GREEN)✓$(OFF) rabbitmq      http://localhost:15672  $(DIM)(guest/guest)$(OFF)\n"

up-fleet: up ## Also start the worker as a long-lived queue consumer
	@$(COMPOSE) --profile fleet up -d worker
	@printf "$(GREEN)✓$(OFF) worker consuming revendo.publish.q (PROFILE=$${PROFILE:-stealth})\n"

down: ## Stop everything, keep images
	@$(COMPOSE) --profile fleet down --remove-orphans

clean: ## Stop everything and remove volumes and images
	@$(COMPOSE) --profile fleet down --remove-orphans --volumes --rmi local

reset: ## Wipe detector state and restore the seed catalogue
	@$(COMPOSE) exec -T target-site node -e "fetch('http://127.0.0.1:8080/__sentinelle/reset',{method:'POST'}).then(r=>r.json()).then(j=>console.log('  reset:',j.deleted,'keys cleared'))" 2>/dev/null \
	  || printf "$(AMBER)  (nothing to reset)$(OFF)\n"

logs: ## Tail logs from every running service
	@$(COMPOSE) --profile fleet logs -f --tail=80

ps: ## Show service status
	@$(COMPOSE) --profile fleet ps

screenshot: ## Regenerate the README console image from the live dashboard
	@mkdir -p docs/img
	@# --user root only here: the worker image runs unprivileged (uid 10001), which
	@# cannot write to a host-owned bind mount. This is a dev utility, not the
	@# production path, so the override is explicit and scoped to one command.
	@$(COMPOSE) run --rm -T --user root -v "$$PWD/docs/img:/out" -v "$$PWD/ops:/app/ops:ro" \
	  worker node /app/ops/screenshot.mjs

console: ## Open the Sentinelle console
	@(command -v xdg-open >/dev/null && xdg-open http://localhost:8080/__sentinelle) \
	  || (command -v open >/dev/null && open http://localhost:8080/__sentinelle) \
	  || printf "  http://localhost:8080/__sentinelle\n"

# -----------------------------------------------------------------------------
# Tests
#
# All three run in containers, so `make test` works on a machine with no Node and
# no JDK installed.
# -----------------------------------------------------------------------------

test: test-site test-worker test-control ## Run every test suite

# Tests run against each image's `build` stage, which is the only one that has the
# sources and devDependencies — the runtime stages ship compiled output and nothing
# else, which is the point of the multi-stage split.
#
# `find` rather than a `src/**/*.test.ts` glob: /bin/sh has no globstar, so the glob
# reaches tsx as a literal string and the runner cheerfully reports 0 tests passing.
TS_TEST = npx tsx --test $$(find src -name "*.test.ts" | sort | tr "\n" " ")

test-worker: ## Worker: behaviour statistics, signal coverage, header ordering
	@printf "\n$(BOLD)worker$(OFF) $(DIM)— behaviour statistics vs the detector's real thresholds$(OFF)\n"
	@docker build -q --target build -t revendo-worker-test worker >/dev/null
	@docker run --rm --entrypoint sh revendo-worker-test -c '$(TS_TEST)'

test-site: ## Vitrine: noisy-OR scoring, behavioural detection
	@printf "\n$(BOLD)target-site$(OFF) $(DIM)— scoring and detection$(OFF)\n"
	@docker build -q --target build -t revendo-site-test target-site >/dev/null
	@docker run --rm --entrypoint sh revendo-site-test -c '$(TS_TEST)'

test-control: ## Control plane: state machine, retry policy, floor enforcement
	@printf "\n$(BOLD)control-plane$(OFF) $(DIM)— state machine and retry policy$(OFF)\n"
	@docker run --rm -v "$$PWD/control-plane":/app -w /app gradle:8.10-jdk17 gradle --no-daemon test --console=plain

# -----------------------------------------------------------------------------
# Inlined so the repo has no loose script files to keep in sync.
# -----------------------------------------------------------------------------
define SCOREBOARD_JS
const R = { allow: '\033[32m', challenge: '\033[33m', block: '\033[31m' };
fetch('http://127.0.0.1:8080/__sentinelle/recent')
  .then(r => r.json())
  .then(events => {
    const bySession = new Map();
    for (const e of events) if (!bySession.has(e.sessionId)) bySession.set(e.sessionId, e);
    const rows = [...bySession.values()].sort((a, b) => a.at - b.at);
    if (!rows.length) { console.log('\n  no sessions recorded yet\n'); return; }
    console.log('\n\033[1m  SCOREBOARD\033[0m  \033[2m(worst verdict per session)\033[0m\n');
    console.log('  \033[2mscore  verdict     signals  action    identity\033[0m');
    for (const e of rows) {
      const v = String(e.verdict).split(' ')[0];
      const colour = R[v] || '';
      const bar = '█'.repeat(Math.round(e.score / 5)).padEnd(20, '\033[2m░\033[0m');
      console.log(
        '  ' + colour + String(e.score).padStart(3) + '\033[0m    ' +
        colour + v.padEnd(10) + '\033[0m  ' +
        String((e.detections || []).length).padStart(3) + '      ' +
        String(e.action).padEnd(9) + ' \033[2m' + String(e.userAgent || '').slice(0, 40) + '\033[0m'
      );
    }
    console.log('\n  \033[2mfull signal breakdown → http://localhost:8080/__sentinelle\033[0m\n');
  })
  .catch(() => console.log('\n  scoreboard unavailable\n'));
endef
export SCOREBOARD_JS
