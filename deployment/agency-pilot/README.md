# Chilli Consent — agency pilot

A small agency-operated service around the audited **c15t backend/browser 3.0.0** packages. The upstream engine remains unmodified. This directory is independent of the monorepo's Bun workspaces: its npm lockfile defines the exact production dependencies.

The pilot provides an authenticated admin overview, site creation, per-site installation snippets, branded Swedish preference UI, preview pages and actual consent counts/recent records. Each site has a server-assigned UUID, a separate SQLite database and a required c15t tenant scope. There is no billing, scheduled scanner, customer self-service or high-availability claim yet.

## Run on Oderland Cloud

Use Docker and Compose on the existing host. DNS for `consent.chillimedia.se` must point to that host before obtaining HTTPS. The process binds only to host loopback port **3090** through Compose; it must sit behind the host HTTPS reverse proxy.

1. Check out the `agency-pilot` branch from `ChillimediaAnalytics/c15t` on the server.
2. In `deployment/agency-pilot`, copy `.env.example` to `.env` and set `PUBLIC_URL` to the HTTPS origin. Generate separate, strong `ADMIN_PASSWORD` and `MASTER_SECRET` values; preserve them across releases. The default admin username is `admin`.
3. `docker compose config --quiet`
4. `PILOT_IMAGE=chilli-consent:<git-sha> docker compose build --pull app`
5. `PILOT_IMAGE=chilli-consent:<git-sha> docker compose up -d --wait app`
6. Proxy the dedicated HTTPS hostname to `http://127.0.0.1:3090`. Do not change the ChilliGPT stack, its networks, Mongo volumes or routes.
7. Check `/healthz`, authenticate at `/admin/`, create a pilot site, and test its preview. No customer site is changed automatically.

Do not start paid client service until the exact client integration has passed pre-consent/rejection/acceptance/withdrawal checks and operational recovery has been exercised. Scripts that are not declared/gated by category are not magically made safe by installing the loader. The pilot uses an opt-in rule as the default for all visitors.

## Development and verification

Node **24** is required. From this directory:

```sh
npm ci --ignore-scripts
npm run check
npm test
npm audit --omit=dev
```

The HTTP tests exercise admin authentication, CSRF, strict origin handling, per-site initialization, private record access, and SQLite backup. Original consent lifecycle browser tests and source tenant checks are recorded in the separate project audit. Never put credentials into source or frontend scripts.

## Backup and rollback

```sh
docker compose exec -T app node backup.mjs /backups
```

This uses SQLite's online backup API rather than copying a live WAL file. The backup directory is a separate named volume. An operator must arrange encrypted off-host copies, retention and periodic restore checks before production. Runtime keys also need protected backup: the database alone is not a complete recovery plan.

For a code rollback, point `PILOT_IMAGE` at the previous verified image and run Compose again. Preserve the named volumes and `.env`. Review migrations and restore from backup if the data schema has changed; do not use `down -v`.

## Licensing

The upstream c15t code and this pilot use Apache 2.0. Retain the root LICENSE.md and NOTICE when distributing derived artifacts. The visual configuration hides the ordinary c15t branding badge through the supported UI option; this does not grant any upstream trademark or CMP certification rights.
