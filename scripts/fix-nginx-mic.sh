#!/bin/bash
# Fix Permissions-Policy to allow microphone and camera for WebRTC softphone
set -e

for f in /etc/nginx/sites-enabled/connectcomms /etc/nginx/sites-available/connectcomms; do
  if [ -f "$f" ]; then
    sudo sed -i 's/microphone=()/microphone=(self)/g' "$f"
    sudo sed -i 's/camera=()/camera=(self)/g' "$f"
    echo "Updated: $f"
  fi
done

echo "Testing nginx config..."
sudo nginx -t

echo "Reloading nginx..."
sudo systemctl reload nginx

echo "Verifying..."
curl -sI https://app.connectcomunications.com/ | grep -i permissions-policy

echo "Done."
