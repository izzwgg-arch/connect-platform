# Nginx WebSocket Proxy — Telephony Service

The telephony service WebSocket runs on `127.0.0.1:3003` inside the ConnectComms server.
The browser cannot reach this port directly. Add this `location` block to the Nginx
virtual-host config that serves `app.connectcomunications.com`.

```nginx
# /etc/nginx/sites-available/app.connectcomunications.com  (inside server{} block)

# ── Telephony WebSocket ───────────────────────────────────────────────────────
location /ws/telephony {
    proxy_pass http://127.0.0.1:3003/ws/telephony;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 86400s;  # keep WS alive for up to 24 h
    proxy_send_timeout 86400s;
}

# ── Telephony REST (optional — for direct calls from portal or admin scripts) ─
location /telephony-api/ {
    proxy_pass http://127.0.0.1:3003/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

After adding, reload Nginx:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Then set the portal env:

```env
NEXT_PUBLIC_TELEPHONY_WS_URL=wss://app.connectcomunications.com/ws/telephony
```

Rebuild and redeploy the portal container after this change.
