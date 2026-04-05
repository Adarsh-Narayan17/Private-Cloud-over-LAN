#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  pipeline.sh — Run the full CI/CD pipeline LOCALLY
#  No GitHub needed — run this on your own laptop/lab machine
#
#  Usage:  bash pipeline.sh
#          bash pipeline.sh --skip-docker   (if Docker not installed)
# ═══════════════════════════════════════════════════════════════

# ── Colors ────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

SKIP_DOCKER=false
[[ "$1" == "--skip-docker" ]] && SKIP_DOCKER=true

PASS=0; FAIL=0

step() { echo -e "\n${CYAN}${BOLD}━━━ STEP $1: $2 ━━━${NC}"; }
ok()   { echo -e "${GREEN}  ✅ $1${NC}"; ((PASS++)); }
err()  { echo -e "${RED}  ❌ $1${NC}"; ((FAIL++)); }
info() { echo -e "${YELLOW}  ℹ  $1${NC}"; }

# ── Header ────────────────────────────────────────────────────────
echo -e "${CYAN}${BOLD}"
echo "╔══════════════════════════════════════════════════╗"
echo "║     SaaS Cloud — Local CI/CD Pipeline            ║"
echo "║     Build → Test → Docker → Deploy               ║"
echo "╚══════════════════════════════════════════════════╝"
echo -e "${NC}"
echo "  Started at: $(date)"
echo "  Directory : $(pwd)"

# ════════════════════════════════════════════════════════════════
#  STEP 1 — CHECK REQUIREMENTS
# ════════════════════════════════════════════════════════════════
step 1 "Checking Requirements"

# Check Node.js
if command -v node &>/dev/null; then
  ok "Node.js $(node -v) found"
else
  err "Node.js not installed! Run: sudo apt install nodejs"
  exit 1
fi

# Check npm
if command -v npm &>/dev/null; then
  ok "npm $(npm -v) found"
else
  err "npm not found"
  exit 1
fi

# Check Docker (optional)
if command -v docker &>/dev/null; then
  ok "Docker $(docker --version | cut -d' ' -f3) found"
  DOCKER_AVAILABLE=true
else
  info "Docker not found — will skip Docker steps"
  DOCKER_AVAILABLE=false
fi

# ════════════════════════════════════════════════════════════════
#  STEP 2 — INSTALL DEPENDENCIES
# ════════════════════════════════════════════════════════════════
step 2 "Installing Dependencies"

npm install --silent
if [ $? -eq 0 ]; then
  ok "npm install succeeded"
  ok "node_modules ready ($(ls node_modules | wc -l) packages)"
else
  err "npm install failed"
  exit 1
fi

# ════════════════════════════════════════════════════════════════
#  STEP 3 — RUN TESTS
# ════════════════════════════════════════════════════════════════
step 3 "Running Automated Tests"

node tests/cloud.test.js
TEST_EXIT=$?

if [ $TEST_EXIT -eq 0 ]; then
  ok "All tests passed ✅"
else
  err "Tests FAILED — stopping pipeline"
  echo -e "\n${RED}  Pipeline aborted. Fix failing tests before deploying.${NC}\n"
  exit 1
fi

# ════════════════════════════════════════════════════════════════
#  STEP 4 — BUILD DOCKER IMAGE
# ════════════════════════════════════════════════════════════════
step 4 "Building Docker Image"

if [ "$SKIP_DOCKER" = true ] || [ "$DOCKER_AVAILABLE" = false ]; then
  info "Skipping Docker build (Docker not available or --skip-docker flag set)"
else
  echo "  Building saas-cloud:latest..."
  docker build -t saas-cloud:latest . --quiet
  if [ $? -eq 0 ]; then
    ok "Docker image built: saas-cloud:latest"
    IMAGE_SIZE=$(docker image inspect saas-cloud:latest --format='{{.Size}}' | awk '{printf "%.1f MB", $1/1048576}')
    ok "Image size: $IMAGE_SIZE"
  else
    err "Docker build failed"
    exit 1
  fi

  # ── Test the container ──────────────────────────────────────────
  echo ""
  info "Starting test container..."
  docker run -d \
    --name saas-cloud-test \
    -p 3001:3000 \
    -e CLOUD_SECRET=pipeline-test-secret \
    saas-cloud:latest > /dev/null

  sleep 4

  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/api/status)
  if [ "$HTTP_CODE" = "200" ]; then
    ok "Container health check passed (HTTP $HTTP_CODE)"
  else
    err "Container health check failed (HTTP $HTTP_CODE)"
  fi

  # Cleanup test container
  docker stop saas-cloud-test > /dev/null 2>&1
  docker rm saas-cloud-test > /dev/null 2>&1
  ok "Test container cleaned up"
fi

# ════════════════════════════════════════════════════════════════
#  STEP 5 — DEPLOY (Local / LAN)
# ════════════════════════════════════════════════════════════════
step 5 "Deploying to Local Server"

if [ "$SKIP_DOCKER" = true ] || [ "$DOCKER_AVAILABLE" = false ]; then
  # Deploy without Docker — just restart with node
  info "Deploying without Docker (node process)..."

  # Kill any existing server on port 3000
  PID=$(lsof -ti:3000 2>/dev/null)
  if [ ! -z "$PID" ]; then
    kill $PID 2>/dev/null
    sleep 1
    info "Stopped existing server (PID $PID)"
  fi

  # Start fresh
  nohup node server/cloud_controller.js > server.log 2>&1 &
  NEW_PID=$!
  sleep 3

  if kill -0 $NEW_PID 2>/dev/null; then
    ok "Server started (PID $NEW_PID)"
    ok "Running at: http://localhost:3000"
    ok "LAN access: http://$(hostname -I | awk '{print $1}'):3000"
    echo $NEW_PID > .server.pid
  else
    err "Server failed to start — check server.log"
  fi

else
  # Deploy with Docker Compose
  info "Deploying with Docker Compose..."

  if command -v docker-compose &>/dev/null || docker compose version &>/dev/null 2>&1; then
    # Stop old container if running
    docker-compose down 2>/dev/null || docker compose down 2>/dev/null

    # Start new container
    docker-compose up -d 2>/dev/null || docker compose up -d 2>/dev/null

    if [ $? -eq 0 ]; then
      sleep 3
      ok "Docker Compose deployment successful"
      ok "Running at: http://localhost:3000"
      ok "LAN access: http://$(hostname -I | awk '{print $1}'):3000"
    else
      err "Docker Compose deployment failed"
    fi
  else
    info "Docker Compose not found — using plain Docker..."
    docker stop saas-cloud-prod 2>/dev/null
    docker rm saas-cloud-prod 2>/dev/null
    docker run -d \
      --name saas-cloud-prod \
      -p 3000:3000 \
      -e CLOUD_SECRET=my-lab-secret \
      -v saas_blocks:/app/storage/blocks \
      -v saas_meta:/app/storage/metadata \
      --restart unless-stopped \
      saas-cloud:latest

    if [ $? -eq 0 ]; then
      ok "Container deployed: saas-cloud-prod"
      ok "Running at: http://localhost:3000"
    else
      err "Docker deployment failed"
    fi
  fi
fi

# ════════════════════════════════════════════════════════════════
#  SUMMARY
# ════════════════════════════════════════════════════════════════
echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  Pipeline Summary"
echo -e "  Finished: $(date)"
echo -e "  Steps OK : ${GREEN}${PASS}${NC}"
echo -e "  Steps ERR: ${RED}${FAIL}${NC}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

if [ $FAIL -eq 0 ]; then
  echo -e "\n  ${GREEN}${BOLD}🎉 Pipeline completed successfully!${NC}"
  echo -e "  ${GREEN}Open: http://localhost:3000${NC}\n"
  exit 0
else
  echo -e "\n  ${RED}${BOLD}⚠️  Pipeline completed with errors.${NC}\n"
  exit 1
fi