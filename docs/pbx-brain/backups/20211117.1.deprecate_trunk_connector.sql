use `ombutel`;

/**
  Remove menu
 */
delete
from `ombu_menu`
where `label` in
      ('menu.trunks_connector_routing', 'menu.trunks_connector_extensions', 'menu.trunks_connector');

# Remove modules
delete
from `ombu_modules`
where `name` in ('trunks_connector_routing', 'trunks_connector_extensions');

# Drop Tables
drop table if exists
    `ombu_trunks_connector_extensions`,
    `ombu_trunks_connector_routing`;