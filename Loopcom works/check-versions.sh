#!/bin/bash
export HOME=/home/deploy
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
echo "Node: $(node -v)"
echo "pnpm: $(pnpm -v)"
echo "PM2: $(pm2 -v)"
