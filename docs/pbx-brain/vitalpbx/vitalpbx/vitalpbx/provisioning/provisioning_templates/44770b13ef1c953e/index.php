<?php
require_once('/usr/share/vitalpbx/www/includes/cli.php');

use modules\provisioning\Device;
use vitalpbx\tenant;

error_reporting(E_ALL);
ini_set('display_errors', 0);
ini_set('html_errors', false);

$filename = arrayGet('filename', $_GET);
$mac_address = parse_mac_address(arrayget('mac', $_GET));
if ($filename !== null && $mac_address !== null) {
    $dev = Device::getByMAC(format_mac_address($mac_address));
    if($dev->id){
        $devTenant = new tenant($dev->tenant);
        if($devTenant->path === "44770b13ef1c953e"){
	        $file = $dev->getProvisioningFile();
	        //If the provisioning file doesn't exists, then, try to generating the provisioning file
	        if(!$file){
	           $dev->generateProvisioningFile();
	           $file = $dev->getProvisioningFile();
	        }
	
	        if($file){
	            header('Content-Type: text/plain');
	            header('Content-Length: ' . filesize($file));
	            readfile($file);
	            exit;
	        }
        }
        
        // --- Return 403 Forbidden for known device but no file ---
	    header('HTTP/1.1 403 Forbidden');
	    echo "Forbidden: Unable to serve provisioning file.";
	    exit;
    }
}

function format_mac_address($mac){
    $mac = trim($mac);
    if(strlen($mac) === 12)
        $mac = implode(':',str_split($mac, 2));

    return $mac;
}

function parse_mac_address($string) {
        if (preg_match('/[0-9a-fA-F]{12}/',$string,$m)) {
                return strtolower($m[0]);
        }
        return null;
}

function arrayGet($name, &$array, $default = null) {
    return $array[$name] ?? $default;
}


// --- Fallback: 404 for invalid or missing MAC/filename ---
header('HTTP/1.1 404 Not Found');
echo "404 Not Found: Invalid provisioning request.";
exit;