-- Mirror grants for the EXTENSION-ADD path (2026-09-16). Idempotent.
--
-- ⛔ WHY THIS FILE EXISTS: `mirror-grants-20260819.sql` granted only the
-- TENANT-CREATE tables. `/mirror/extension-add` shipped later (helper
-- 2026.08.23.1) and was proven on the CLONE as MySQL **root**
-- (`add-extension-accept.py` connects as root and refuses to run where a
-- licence file exists), so nobody ever noticed that on PRODUCTION the helper's
-- own user cannot INSERT into the extension tables. Proven live 2026-09-16:
--   (1142, "INSERT command denied to user 'connect_route_helper'@'localhost'
--    for table `ombutel`.`ombu_extensions`")
--
-- The table list is exactly what mirror_writes.add_extension inserts into.
-- `ombu_numbers` already carries SELECT,INSERT from the 2026-08-19 file.
-- Additive only: INSERT, no DELETE, no widened UPDATE.
--
-- Run on the PBX as root:
--   mysql -N -e "show grants for connect_route_helper@localhost" > /root/grants-connect_route_helper-backup-$(date +%Y%m%dT%H%M%SZ).sql
--   mysql < /root/mirror-extension-grants-20260916.sql

GRANT INSERT ON ombutel.ombu_extensions              TO 'connect_route_helper'@'localhost';
GRANT INSERT ON ombutel.ombu_devices                 TO 'connect_route_helper'@'localhost';
GRANT INSERT ON ombutel.ombu_pjsip_devices           TO 'connect_route_helper'@'localhost';
GRANT INSERT ON ombutel.ombu_extensions_vm           TO 'connect_route_helper'@'localhost';
GRANT INSERT ON ombutel.ombu_extensions_contact_info TO 'connect_route_helper'@'localhost';
GRANT INSERT ON ombutel.ombu_followme                TO 'connect_route_helper'@'localhost';
GRANT INSERT ON ombutel.ombu_extension_diversions    TO 'connect_route_helper'@'localhost';

GRANT INSERT ON ombutel.ombu_extensions              TO 'connect_route_helper'@'127.0.0.1';
GRANT INSERT ON ombutel.ombu_devices                 TO 'connect_route_helper'@'127.0.0.1';
GRANT INSERT ON ombutel.ombu_pjsip_devices           TO 'connect_route_helper'@'127.0.0.1';
GRANT INSERT ON ombutel.ombu_extensions_vm           TO 'connect_route_helper'@'127.0.0.1';
GRANT INSERT ON ombutel.ombu_extensions_contact_info TO 'connect_route_helper'@'127.0.0.1';
GRANT INSERT ON ombutel.ombu_followme                TO 'connect_route_helper'@'127.0.0.1';
GRANT INSERT ON ombutel.ombu_extension_diversions    TO 'connect_route_helper'@'127.0.0.1';

FLUSH PRIVILEGES;
