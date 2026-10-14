# SimCare MySQL Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move mutable project data to MySQL and display patient identity from stored case data.

**Architecture:** Existing SQLAlchemy models provide the portal and user layer. A shared store provides versioned case content and engine session snapshots. A one-time importer moves SQLite and JSON records into the clean `simcare` database.

**Tech Stack:** Python 3.12+, SQLAlchemy, PyMySQL, MySQL 8, PowerShell, browser JavaScript.

**Spec:** `docs/superpowers/specs/2026-10-12-mysql-storage-design.md`

## Global Constraints

- Never commit database credentials or change other databases.
- Preserve the original SQLite and JSON files during import.
- Use `utf8mb4`; run all application writes through MySQL transactions.
- New case content applies to new sessions; history remains immutable.

## Review Focus

- MySQL is unavailable: startup fails clearly without silently writing SQLite.
- Repeated import: existing rows are not overwritten or duplicated.
- Unicode patient names round-trip unchanged.
- English and Uyghur engines retain correct case identity and session routing.
- An existing training record reopens after engine restart.

---

### Task 1: Connection and portal schema

**Files:** `environment.yml`, `server.py`, `Start.ps1`, `Restart-Local.ps1`, `backend/main/app/{config,db,migrations,models,portal_models}.py`, `backend/extensions/{shared_language,attempt_language}.py`.

- [x] Write and run a failing MySQL connection/schema smoke test.
- [x] Configure `DATABASE_URL` from ignored local configuration and add PyMySQL dependency.
- [x] Make schema creation and language tables MySQL compatible.
- [x] Migrate and verify existing portal/user rows.

### Task 2: Engine session persistence

**Files:** `backend/runtime/engine_store.py`, seven active engine `server.py` files, migration script.

- [x] Run a create/reload session round-trip test against MySQL.
- [x] Add `engine_sessions` and `engine_attempt_links` tables.
- [x] Replace JSON session reads/writes and attempt-link files with transactional MySQL operations.
- [x] Import historical JSON snapshots and verify restart recovery.

### Task 3: Case content and dynamic identity

**Files:** `backend/runtime/case_store.py`, active case engine files, active browser app files, migration script.

- [x] Run a case-profile round-trip test, including a changed patient name.
- [x] Add `case_content` keyed by engine, seeded from existing case definitions.
- [x] Read case identity and report metadata for each new session from MySQL.
- [x] Render reception, scene caption, examination and report headers from `registration`.

### Task 4: End-to-end verification

- [x] Start all engines and portal against MySQL, verify health and reopen a migrated practice attempt.
- [x] Verify clinical and language routes, migration counts, and MySQL round trips.
- [x] Document local and server setup plus recovery steps.
