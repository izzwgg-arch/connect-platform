#!/usr/bin/env python3
import base64
import os

# Read the local file
with open('app/dashboard/clients/[id]/edit/page.tsx', 'r', encoding='utf-8') as f:
    content = f.read()

# Ensure Unix line endings
content = content.replace('\r\n', '\n').replace('\r', '\n')

# Write to server path
server_path = '/root/apps/trimpro/app/dashboard/clients/[id]/edit/page.tsx'
os.makedirs(os.path.dirname(server_path), exist_ok=True)

with open(server_path, 'w', encoding='utf-8', newline='\n') as f:
    f.write(content)

print(f"File written to {server_path}")
print(f"File size: {len(content)} bytes")
print(f"Lines: {len(content.splitlines())}")
