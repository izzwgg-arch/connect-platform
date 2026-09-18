#!/usr/bin/env python3
import base64
import sys
import os

# Read base64 content from file
base64_file = '/tmp/base64_content.txt'
if not os.path.exists(base64_file):
    print(f"Error: {base64_file} not found")
    sys.exit(1)

with open(base64_file, 'rb') as f:
    base64_content = f.read().decode('utf-8', errors='ignore').strip()

# Remove any BOM or extra whitespace
base64_content = base64_content.replace('\ufeff', '').replace('\r', '').replace('\n', '').strip()

try:
    content = base64.b64decode(base64_content).decode('utf-8')
except Exception as e:
    print(f"Error decoding base64: {e}")
    print(f"Base64 length: {len(base64_content)}")
    print(f"First 100 chars: {base64_content[:100]}")
    sys.exit(1)

file_path = '/root/apps/trimpro/app/dashboard/clients/[id]/edit/page.tsx'
os.makedirs(os.path.dirname(file_path), exist_ok=True)

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print(f"SUCCESS: File written to {file_path}")
print(f"File size: {len(content)} bytes")
print(f"Lines: {len(content.splitlines())}")
