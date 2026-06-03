SHELL := /bin/zsh

APP_NAME := Termius
HOST := 127.0.0.1
PORT := 1420
PID_DIR := .run
LOG_DIR := logs
WEB_PID := $(PID_DIR)/web.pid
WEB_LOG := $(LOG_DIR)/web.log
TAURI_DIR := src-tauri
APP_DATA_DIR := $(HOME)/Library/Application Support/com.okta.sshmanage

.PHONY: help install start stop restart redeploy build desktop clear uninstall status

help:
	@echo "Okta SSHManage / Termius Makefile"
	@echo ""
	@echo "Targets:"
	@echo "  make install    Install npm dependencies"
	@echo "  make start      Start Vite web dev service on http://$(HOST):$(PORT)"
	@echo "  make stop       Stop Vite web dev service"
	@echo "  make restart    Stop then start web service"
	@echo "  make redeploy   Install deps, rebuild frontend, rebuild macOS app, restart web service"
	@echo "  make build      Build frontend only"
	@echo "  make desktop    Build macOS .app bundle"
	@echo "  make status     Show web service status"
	@echo "  make clear      Remove generated build/log/runtime files"
	@echo "  make uninstall  Stop service and remove deps, builds, logs, and local app data"

install:
	npm install

start:
	@mkdir -p "$(PID_DIR)" "$(LOG_DIR)"
	@if [ -f "$(WEB_PID)" ] && kill -0 "$$(cat "$(WEB_PID)")" 2>/dev/null; then \
		echo "Web service already running with PID $$(cat "$(WEB_PID)")"; \
	else \
		echo "Starting web service on http://$(HOST):$(PORT)"; \
		nohup npx vite --host "$(HOST)" --port "$(PORT)" > "$(WEB_LOG)" 2>&1 & echo $$! > "$(WEB_PID)"; \
		sleep 1; \
		if kill -0 "$$(cat "$(WEB_PID)")" 2>/dev/null; then \
			echo "Started with PID $$(cat "$(WEB_PID)")"; \
			echo "Logs: $(WEB_LOG)"; \
		else \
			echo "Failed to start. Check $(WEB_LOG)"; \
			rm -f "$(WEB_PID)"; \
			exit 1; \
		fi; \
	fi

stop:
	@if [ -f "$(WEB_PID)" ]; then \
		PID="$$(cat "$(WEB_PID)")"; \
		if kill -0 "$$PID" 2>/dev/null; then \
			echo "Stopping web service PID $$PID"; \
			kill "$$PID"; \
			sleep 1; \
			if kill -0 "$$PID" 2>/dev/null; then \
				echo "Force stopping PID $$PID"; \
				kill -9 "$$PID"; \
			fi; \
		else \
			echo "PID file exists but service is not running"; \
		fi; \
		rm -f "$(WEB_PID)"; \
	else \
		echo "No PID file found. Trying fallback stop by port $(PORT)."; \
		PIDS="$$(lsof -ti tcp:$(PORT) 2>/dev/null)"; \
		if [ -n "$$PIDS" ]; then \
			echo "$$PIDS" | xargs kill; \
			echo "Stopped process(es) on port $(PORT): $$PIDS"; \
		else \
			echo "Web service is not running"; \
		fi; \
	fi

restart: stop start

redeploy: stop install build desktop start

build:
	npm run build

desktop:
	npm run desktop:build

status:
	@if [ -f "$(WEB_PID)" ] && kill -0 "$$(cat "$(WEB_PID)")" 2>/dev/null; then \
		echo "Web service running with PID $$(cat "$(WEB_PID)")"; \
		echo "URL: http://$(HOST):$(PORT)"; \
	else \
		PIDS="$$(lsof -ti tcp:$(PORT) 2>/dev/null)"; \
		if [ -n "$$PIDS" ]; then \
			echo "Port $(PORT) is used by PID(s): $$PIDS"; \
		else \
			echo "Web service is stopped"; \
		fi; \
	fi

clear: stop
	rm -rf dist "$(TAURI_DIR)/target" "$(PID_DIR)" "$(LOG_DIR)"

uninstall: stop
	rm -rf node_modules dist "$(TAURI_DIR)/target" "$(PID_DIR)" "$(LOG_DIR)" "$(APP_DATA_DIR)"
