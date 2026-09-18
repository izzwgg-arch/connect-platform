import os

p = os.path.join('app', 'dashboard', 'items', 'bundles', '[id]', 'edit', 'page.tsx')
with open(p, 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Find and replace lines 350-359 (0-indexed: 349-358)
new_lines = []
skip_until = -1
for i, line in enumerate(lines):
    if skip_until > 0 and i < skip_until:
        continue
    if '<Link href={`/dashboard/items/${bundleId' in line:
        # Replace lines 350-359 with simple back button
        new_lines.append('        <Button variant="ghost" size="sm" onClick={() => router.back()}>\n')
        new_lines.append('          <ArrowLeft className="mr-2 h-4 w-4" />\n')
        new_lines.append('          Back\n')
        new_lines.append('        </Button>\n')
        # Skip until after </Link>
        for j in range(i+1, len(lines)):
            if '</Link>' in lines[j]:
                skip_until = j + 1
                break
        continue
    new_lines.append(line)

with open(p, 'w', encoding='utf-8') as f:
    f.writelines(new_lines)

print(f'Fixed {p}')
