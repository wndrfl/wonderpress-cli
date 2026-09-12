#!/usr/bin/env bash
#
# Build a throwaway WonderPress environment in ./wp for kicking the tyres on the
# local CLI. Destroys and rebuilds cleanly, every time.
#
# Usage:
#   ./bootstrap.sh                 # build with the host backend (MySQL + wp server)
#   ./bootstrap.sh --env wp-env    # build with the wp-env backend (Docker)
#   ./bootstrap.sh --fresh         # tear down, then build
#   ./bootstrap.sh --destroy       # just tear it down and stop
#
# The host backend is the default, matching the CLI.
#
set -euo pipefail

SANDBOX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WP_DIR="$SANDBOX_DIR/wp"
# The CLI under test is the repo this sandbox lives in. Point elsewhere with
# WONDERPRESS_CLI_DIR to test a different checkout.
CLI_DIR="${WONDERPRESS_CLI_DIR:-$(cd "$SANDBOX_DIR/.." && pwd)}"
CLI_BIN="$CLI_DIR/bin/wonderpress.js"

# The environment under test. Override any of these by exporting them first.
DB_HOST="${WP_DB_HOST:-127.0.0.1}"
DB_USER="${WP_DB_USER:-root}"
DB_NAME="${WP_DB_NAME:-wonderpress_sandbox}"
SITE_URL="${WP_SITE_URL:-localhost:8080}"
SITE_TITLE="${WP_SITE_TITLE:-WonderPress Sandbox}"
ADMIN_USER="${WP_ADMIN_USER:-admin}"
ADMIN_EMAIL="${WP_ADMIN_EMAIL:-admin@example.com}"
ADMIN_PASS="${WP_ADMIN_PASSWORD:-sandbox}"
THEME="${WP_THEME:-wonderpress}"
BACKEND="${WP_BACKEND:-host}"
WP_ENV_PORT="${WP_ENV_PORT:-8888}"

info() { printf '\033[36m==>\033[0m %s\n' "$1"; }
fail() { printf '\033[31mError:\033[0m %s\n' "$1" >&2; exit 1; }

FRESH=0
DESTROY_ONLY=0
# A shifting loop, not `for arg in "$@"` — --env takes a value.
while [ $# -gt 0 ]; do
	case "$1" in
		--env)     shift; [ $# -gt 0 ] || fail "--env needs a value (host|wp-env)."; BACKEND="$1" ;;
		--env=*)   BACKEND="${1#*=}" ;;
		--fresh)   FRESH=1 ;;
		--destroy) DESTROY_ONLY=1 ;;
		-h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) echo "Unknown option: $1 (try --help)" >&2; exit 1 ;;
	esac
	shift
done
case "$BACKEND" in
	host|wp-env) ;;
	*) fail "unknown --env '$BACKEND' (expected: host, wp-env)" ;;
esac

# wp-env is a devDependency of the environment itself, installed by `init`.
WP_ENV_BIN="$WP_DIR/node_modules/.bin/wp-env"

destroy() {
	# Infer from what is on disk rather than trusting $BACKEND: --destroy is
	# often run later, from a different invocation than the one that built it.
	#
	# Containers MUST come down before the directory does. wp-env does not need
	# .wp-env.json to tear down, but it does need the directory to still exist —
	# recreating it later gives "Environment not initialized" and the
	# containers, volumes and images are stranded.
	if [ -d "$WP_DIR" ] && [ -x "$WP_ENV_BIN" ]; then
		if docker info >/dev/null 2>&1; then
			info "Destroying the Docker environment (containers, volumes, images)"
			( cd "$WP_DIR" && "$WP_ENV_BIN" destroy --force ) \
				|| echo "  (wp-env destroy failed — check \`docker ps -a\` and \`docker volume ls\`)"
		else
			echo "  Warning: $WP_DIR looks like a Docker environment but Docker is not"
			echo "  reachable, so its containers and volumes will be left behind."
			echo "  Start Docker and re-run --destroy to clean up properly."
		fi
	elif [ ! -f "$WP_DIR/.wp-env.json" ]; then
		info "Dropping database $DB_NAME"
		mysql -h "$DB_HOST" -u "$DB_USER" ${WP_DB_PASSWORD:+-p"$WP_DB_PASSWORD"} \
			-e "DROP DATABASE IF EXISTS \`$DB_NAME\`" 2>/dev/null \
			|| echo "  (could not drop $DB_NAME — carrying on)"
	fi

	if [ -d "$WP_DIR" ]; then
		info "Removing $WP_DIR"
		rm -rf "$WP_DIR"
	fi
}

if [ "$DESTROY_ONLY" = "1" ]; then
	destroy
	info "Sandbox destroyed."
	exit 0
fi

# Preflight: fail early and specifically rather than halfway through a WP install.
#
# Both backends need wp/php/composer. wp-env replaces MySQL, not the PHP
# toolchain: `wp core download` still runs on the host and must happen before
# the containers start, and composer still produces the vendor/bin/phpcs that
# `wonderpress lint` runs.
for cmd in node wp php composer; do
	command -v "$cmd" >/dev/null 2>&1 || fail "\`$cmd\` not found on PATH."
done
[ -f "$CLI_BIN" ] || fail "CLI not found at $CLI_BIN (set WONDERPRESS_CLI_DIR)."

if [ "$BACKEND" = "host" ]; then
	for cmd in mysql mysqladmin; do
		command -v "$cmd" >/dev/null 2>&1 || fail "\`$cmd\` not found on PATH."
	done
	mysqladmin -h "$DB_HOST" -u "$DB_USER" ${WP_DB_PASSWORD:+-p"$WP_DB_PASSWORD"} ping >/dev/null 2>&1 \
		|| fail "MySQL is not reachable at $DB_HOST as $DB_USER. Start it (brew services start mysql)."
else
	command -v docker >/dev/null 2>&1 \
		|| fail "\`docker\` not found on PATH. Install Docker Desktop, or build the host backend with --env host."
	docker compose version >/dev/null 2>&1 \
		|| fail "The Docker Compose v2 plugin is missing (wp-env runs \`docker compose\`, not \`docker-compose\`)."
	docker info >/dev/null 2>&1 \
		|| fail "Docker is installed but the daemon is not responding. Start Docker Desktop, then check: docker info"
	if lsof -nP -iTCP:"$WP_ENV_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
		fail "Port $WP_ENV_PORT is already bound (another wp-env environment?). Free it, or export WP_ENV_PORT."
	fi
fi

if [ "$FRESH" = "1" ]; then
	destroy
elif [ -d "$WP_DIR" ]; then
	fail "$WP_DIR already exists. Use --fresh to rebuild it, or --destroy to remove it."
fi

# Which CLI is being tested — the whole point of the sandbox, so say it out loud.
CLI_BRANCH="$(git -C "$CLI_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'unknown')"
CLI_COMMIT="$(git -C "$CLI_DIR" rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
info "CLI under test: $CLI_DIR (branch $CLI_BRANCH @ $CLI_COMMIT)"

# Keep the CLI's own deps current — a stale node_modules is the classic way to
# test something other than what you think you're testing.
info "Installing CLI dependencies"
(cd "$CLI_DIR" && npm install --silent)

info "Building the $BACKEND environment in $WP_DIR (this takes a few minutes)"
mkdir -p "$WP_DIR"
cd "$WP_DIR"

if [ "$BACKEND" = "host" ]; then
	WP_DB_PASSWORD="${WP_DB_PASSWORD:-}" WP_ADMIN_PASSWORD="$ADMIN_PASS" \
	node "$CLI_BIN" init --yes \
		--db-host "$DB_HOST" --db-user "$DB_USER" --db-name "$DB_NAME" \
		--wp-url "$SITE_URL" --wp-title "$SITE_TITLE" \
		--admin-user "$ADMIN_USER" --admin-email "$ADMIN_EMAIL" \
		--theme "$THEME" --skip-readme
else
	# No --db-* and no --wp-url: wp-env fixes its database at
	# root/password/wordpress and serves on the port in .wp-env.json. The CLI
	# refuses those flags here rather than ignoring them.
	WP_ADMIN_PASSWORD="$ADMIN_PASS" \
	node "$CLI_BIN" init --yes --env wp-env \
		--wp-title "$SITE_TITLE" \
		--admin-user "$ADMIN_USER" --admin-email "$ADMIN_EMAIL" \
		--theme "$THEME" --skip-readme
fi

info "Verifying"
if [ "$BACKEND" = "host" ]; then
	wp core is-installed || fail "WordPress did not install cleanly."
	ACTIVE_THEME="$(wp theme list --status=active --field=name)"
else
	[ -x "$WP_ENV_BIN" ] || fail "wp-env was not installed into $WP_DIR — did the project npm install run?"
	( cd "$WP_DIR" && "$WP_ENV_BIN" run cli wp core is-installed >/dev/null 2>&1 ) \
		|| fail "WordPress did not install cleanly inside the containers."
	# stderr carries wp-env's spinner; stdout is the value.
	ACTIVE_THEME="$( cd "$WP_DIR" && "$WP_ENV_BIN" run cli wp theme list -- --status=active --field=name 2>/dev/null | tr -d '\r' | tail -n1 )"
fi
[ "$ACTIVE_THEME" = "$THEME" ] || fail "Expected the $THEME theme to be active, got $ACTIVE_THEME."
[ -f "$WP_DIR/wp-content/themes/$THEME/static/.staticrc" ] \
	|| echo "  Warning: no static/.staticrc — style/JS delegation will be skipped."

if [ "$BACKEND" = "wp-env" ]; then
cat <<EOF

Sandbox ready (wp-env / Docker backend).

  Site:   http://localhost:$WP_ENV_PORT   (admin area: /wp-admin)
  Login:  $ADMIN_USER / $ADMIN_PASS
  Path:   $WP_DIR

It is already serving — wp-env started it. There is no \`wp server\` here and
nothing to hold in the foreground.

  Stop / start:  cd "$WP_DIR" && $WP_ENV_BIN stop | $WP_ENV_BIN start
  WP-CLI:        cd "$WP_DIR" && $WP_ENV_BIN run cli wp <args>
  PHP logs:      cd "$WP_DIR" && $WP_ENV_BIN logs
  Status/ports:  cd "$WP_DIR" && $WP_ENV_BIN status

Run the CLI under test from inside ./wp — the backend is remembered, so no
--env flag is needed:

  cd "$WP_DIR"
  alias wpd="node $CLI_BIN"
  wpd partial create --theme $THEME --name Testimonial --js --prop quote:string:required
  wpd lint --name $THEME          # phpcs runs on the HOST against the mounted files

Rebuild:   ./bootstrap.sh --env wp-env --fresh
Tear down: ./bootstrap.sh --destroy
           (removes containers, volumes AND images — the next build re-pulls;
            for a wedged database, \`$WP_ENV_BIN clean\` is the cheaper hammer)
EOF
else
cat <<EOF

Sandbox ready (host backend).

  Site:   http://$SITE_URL   (admin area: /wp-admin)
  Login:  $ADMIN_USER / $ADMIN_PASS
  Path:   $WP_DIR

Run the CLI under test from inside ./wp:

  cd "$WP_DIR"
  alias wpd="node $CLI_BIN"
  wpd partial create --theme $THEME --name Testimonial --js --prop quote:string:required
  wpd partial list --theme $THEME

Serve it:  cd "$WP_DIR" && wp server
Rebuild:   ./bootstrap.sh --fresh
EOF
fi
