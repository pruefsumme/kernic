#!/bin/sh
# Checks that this machine and deploy/.env are ready for Kernic, before the first start.
#
#   ./preflight.sh
#
# Nothing is changed. It prints what it found, and exits with an error if something
# has to be fixed first. Warnings are things worth knowing that do not stop an install.
set -eu
cd "$(dirname "$0")"

failed=0
ok() { printf '  ok    %s\n' "$1"; }
warn() { printf '  WARN  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; failed=1; }

# Reads KEY=value from .env without running it as a script.
value() { sed -n "s/^$1=//p" .env 2>/dev/null | tail -n 1 | sed "s/^['\"]//; s/['\"]$//"; }

echo "Docker"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
	ok "Docker and the Compose plugin are installed ($(docker compose version --short 2>/dev/null))"
else
	fail "Docker with the Compose plugin is needed: https://docs.docker.com/engine/install/"
fi

echo "This machine"
kernel="$(uname -r)"
major="${kernel%%.*}"
rest="${kernel#*.}"
minor="${rest%%[!0-9]*}"
if [ "$major" -gt 5 ] || { [ "$major" -eq 5 ] && [ "${minor:-0}" -ge 13 ]; }; then
	ok "Linux $kernel (the compile worker needs 5.13 or newer for Landlock)"
else
	fail "Linux $kernel is too old: the compile worker needs 5.13 or newer and refuses to start otherwise"
fi
if [ -r /sys/kernel/security/lsm ] && ! grep -q landlock /sys/kernel/security/lsm; then
	warn "Landlock is not listed among the kernel's security modules; the worker checks this itself on start"
fi
memory_kb="$(sed -n 's/^MemTotal: *\([0-9]*\) kB/\1/p' /proc/meminfo)"
if [ "${memory_kb:-0}" -ge 1900000 ]; then
	ok "$((memory_kb / 1024)) MB of memory"
else
	warn "$((memory_kb / 1024)) MB of memory is little: 2 GB is comfortable; lower KERNIC_WARM_SESSIONS and KERNIC_LANGUAGE_SESSIONS (see docs/self-hosting.md)"
fi
if command -v docker >/dev/null 2>&1; then
	root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"
	free_kb="$(df -Pk "$root" 2>/dev/null | awk 'NR==2 {print $4}')"
	if [ "${free_kb:-0}" -ge 5000000 ]; then
		ok "$((free_kb / 1024 / 1024)) GB free where Docker keeps its data"
	else
		warn "only $((${free_kb:-0} / 1024)) MB free where Docker keeps its data; the images take about 1 GB, projects need more"
	fi
fi

echo "deploy/.env"
if [ ! -f .env ]; then
	fail ".env is missing: cp .env.example .env, then edit it"
else
	site="$(value KERNIC_SITE_ADDRESS)"
	postgres="$(value POSTGRES_PASSWORD)"
	worker="$(value KERNIC_WORKER_TOKEN)"
	[ -n "$site" ] && ok "KERNIC_SITE_ADDRESS is $site" || fail "KERNIC_SITE_ADDRESS is not set"
	[ "${#postgres}" -ge 16 ] && ok "POSTGRES_PASSWORD is set" || fail "POSTGRES_PASSWORD must be set (openssl rand -hex 32)"
	[ "${#worker}" -ge 24 ] && ok "KERNIC_WORKER_TOKEN is set" || fail "KERNIC_WORKER_TOKEN must be set, 24 characters or more (openssl rand -hex 32)"
	if [ -n "$postgres" ] && [ "$postgres" = "$worker" ]; then
		fail "POSTGRES_PASSWORD and KERNIC_WORKER_TOKEN must be two different values"
	fi
	if [ -n "$(value KERNIC_GIT_HOSTS)" ]; then
		[ "$(value KERNIC_SECRET_KEY | wc -c)" -gt 32 ] \
			&& ok "KERNIC_SECRET_KEY is set for the Git hosts" \
			|| fail "KERNIC_GIT_HOSTS is set, so KERNIC_SECRET_KEY must be set too (32 characters or more)"
	fi
	case "$site" in
	"" | localhost | :*) : ;;
	*)
		if getent hosts "$site" >/dev/null 2>&1; then
			ok "$site resolves to $(getent hosts "$site" | awk '{print $1}' | head -n 1) (it has to be this machine's public address)"
		else
			fail "$site does not resolve yet: point its DNS record at this machine first, or no certificate can be issued"
		fi
		;;
	esac
	if command -v ss >/dev/null 2>&1; then
		for port in "$(value KERNIC_HTTP_PORT)" "$(value KERNIC_HTTPS_PORT)"; do
			port="${port:-}"
			[ -n "$port" ] || continue
			if ss -ltn "( sport = :$port )" 2>/dev/null | grep -q LISTEN; then
				warn "port $port is already in use on this machine; Kernic's proxy cannot take it"
			fi
		done
	fi
fi

echo
if [ "$failed" -eq 0 ]; then
	echo "Ready. Start with: docker compose up -d --build   (or, with published images: docker compose pull && docker compose up -d --no-build)"
else
	echo "Fix the lines marked FAIL, then run this again."
	exit 1
fi
