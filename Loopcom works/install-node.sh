#!/bin/bash
export HOME=/home/deploy

# Install NVM
if [ ! -d "$HOME/.nvm" ]; then
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
fi

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Install Node.js LTS
nvm install --lts
nvm use --lts
nvm alias default node

# Install pnpm
npm install -g pnpm

# Install PM2 and setup startup
npm install -g pm2
pm2 startup systemd -u deploy --hp /home/deploy

echo "Node.js $(node -v) installed"
echo "pnpm $(pnpm -v) installed"
echo "pm2 $(pm2 -v) installed"
