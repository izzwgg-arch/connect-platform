#!/bin/bash
TOKEN="7f462d370c305c446e66f2f3177fa32a"

# Encrypt the new key
ENCRYPTED=$(docker exec app-api-1 node -e "
const crypto = require('crypto');
const key = Buffer.from(process.env.CREDENTIALS_MASTER_KEY, 'hex');
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const value = JSON.stringify({token: '$TOKEN'});
const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
const tag = cipher.getAuthTag();
const envelope = {iv:iv.toString('base64'),tag:tag.toString('base64'),ciphertext:ciphertext.toString('base64'),keyId:'v1'};
process.stdout.write(Buffer.from(JSON.stringify(envelope)).toString('base64'));
" 2>/dev/null)

echo "Encrypted length: ${#ENCRYPTED}"

# Update the PbxInstance
docker exec connectcomms-postgres psql -U connectcomms -d connectcomms -c "UPDATE \"PbxInstance\" SET \"apiAuthEncrypted\" = '$ENCRYPTED', \"updatedAt\" = NOW() WHERE id = 'cmmi7huxy0000qq3igj493o5q'"

echo ""
echo "=== Verify ==="
docker exec connectcomms-postgres psql -U connectcomms -d connectcomms -t -A -c "SELECT id, \"baseUrl\", \"isEnabled\", length(\"apiAuthEncrypted\") as auth_len FROM \"PbxInstance\" WHERE id = 'cmmi7huxy0000qq3igj493o5q'"

echo ""
echo "=== Restart API to pick up new key ==="
docker restart app-api-1
