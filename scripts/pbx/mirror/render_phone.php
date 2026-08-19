<?php
/**
 * PBX Console — render ONE phone's provisioning config with VitalPBX's own generator.
 *
 * ⛔ WHY THIS FILE EXISTS AT ALL. The helper runs as `asterisk`, but VitalPBX's
 * provisioning generator reads /etc/vitalpbx/vitalpbx-maint.conf, which is
 * `-rw------- www-data` — a credentials file that must stay that way. So instead
 * of widening that file's permissions, the helper runs THIS script as www-data
 * through one narrow sudoers line. The script can do exactly one thing: render
 * the config for a MAC that already exists in the provisioning database.
 *
 * ⛔ It takes a MAC and nothing else, validates the shape before use, and never
 * creates, edits or deletes a row — so the sudo grant cannot be turned into
 * "run arbitrary PHP as www-data".
 */
require_once('/usr/share/vitalpbx/www/includes/cli.php');

$raw = $argv[1] ?? '';
if (!preg_match('/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/', $raw)) {
    fwrite(STDERR, "invalid_mac\n");
    exit(2);
}
$mac = strtoupper($raw);

$dev = \modules\provisioning\Device::getByMAC($mac);
if (!$dev || !$dev->id) {
    fwrite(STDERR, "no_device\n");
    exit(3);
}

$dev->generateProvisioningFile();
$file = $dev->getProvisioningFile();
if (!$file || !file_exists($file)) {
    fwrite(STDERR, "not_generated\n");
    exit(4);
}

echo $file . '|' . filesize($file);
