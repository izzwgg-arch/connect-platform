import re

with open('/etc/nginx/sites-enabled/connectcomms', 'r') as f:
    content = f.read()

# Remove any broken /ws/telephony block that sed may have added
content = re.sub(r'\s*location /ws/telephony \{[^}]*\}\s*\n\n\s*location = /ws \{', '\n    location = /ws {', content)

telephony_block = '''    location /ws/telephony {
        proxy_pass http://127.0.0.1:3003;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 60s;
        proxy_send_timeout 86400;
        proxy_read_timeout 86400;
    }

    location = /ws {'''

content = content.replace('    location = /ws {', telephony_block, 1)

with open('/etc/nginx/sites-enabled/connectcomms', 'w') as f:
    f.write(content)

print('Done')
