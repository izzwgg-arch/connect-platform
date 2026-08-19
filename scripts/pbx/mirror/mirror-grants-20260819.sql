-- Mirror grants for the PBX helper's MySQL user (2026-08-19). Idempotent. Run on the PBX as root:
--   mysql -N -e "show grants for connect_route_helper@localhost" > /root/grants-connect_route_helper-backup-$(date +%Y%m%dT%H%M%SZ).sql
--   mysql < /root/mirror-grants-20260819.sql
GRANT SELECT, INSERT ON ombutel.ombu_tenants TO 'connect_route_helper'@'localhost';
GRANT SELECT, INSERT ON ombutel.ombu_tenants_users TO 'connect_route_helper'@'localhost';
GRANT SELECT, INSERT ON ombutel.ombu_tenant_settings TO 'connect_route_helper'@'localhost';
GRANT SELECT, INSERT ON ombutel.ombu_classes_of_service TO 'connect_route_helper'@'localhost';
GRANT SELECT, INSERT ON ombutel.ombu_dial_profiles TO 'connect_route_helper'@'localhost';
GRANT SELECT, INSERT ON ombutel.ombu_maintenance TO 'connect_route_helper'@'localhost';
GRANT SELECT, INSERT ON ombutel.ombu_parking_lots TO 'connect_route_helper'@'localhost';
GRANT SELECT, INSERT ON ombutel.ombu_numbers TO 'connect_route_helper'@'localhost';
GRANT SELECT, INSERT ON ombutel.ombu_ars TO 'connect_route_helper'@'localhost';
GRANT SELECT, INSERT ON ombutel.ombu_tenant_dids TO 'connect_route_helper'@'localhost';
GRANT INSERT ON ombutel.ombu_inbound_routes TO 'connect_route_helper'@'localhost';
GRANT INSERT ON ombutel.ombu_destinations TO 'connect_route_helper'@'localhost';
GRANT SELECT, INSERT ON ombutel.ombu_queued_changes TO 'connect_route_helper'@'localhost';
GRANT SELECT, INSERT ON ombutel.ombu_settings TO 'connect_route_helper'@'localhost';
GRANT SELECT, INSERT ON ombutel.ombu_tenants TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT, INSERT ON ombutel.ombu_tenants_users TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT, INSERT ON ombutel.ombu_tenant_settings TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT, INSERT ON ombutel.ombu_classes_of_service TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT, INSERT ON ombutel.ombu_dial_profiles TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT, INSERT ON ombutel.ombu_maintenance TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT, INSERT ON ombutel.ombu_parking_lots TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT, INSERT ON ombutel.ombu_numbers TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT, INSERT ON ombutel.ombu_ars TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT, INSERT ON ombutel.ombu_tenant_dids TO 'connect_route_helper'@'127.0.0.1';
GRANT INSERT ON ombutel.ombu_inbound_routes TO 'connect_route_helper'@'127.0.0.1';
GRANT INSERT ON ombutel.ombu_destinations TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT, INSERT ON ombutel.ombu_queued_changes TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT, INSERT ON ombutel.ombu_settings TO 'connect_route_helper'@'127.0.0.1';
FLUSH PRIVILEGES;
