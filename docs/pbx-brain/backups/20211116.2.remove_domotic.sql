use `ombutel`;

# Delete Menu
delete
from `ombu_menu`
where `label` in
      ('menu.domotic_units', 'menu.domotic_devices', 'menu.domotic_scenes', 'menu.domotic_notifications',
       'menu.domotic_conf', 'menu.domotic');

# Remove modules
delete
from `ombu_modules`
where `name` in ('domotic_units', 'domotic_devices', 'domotic_scenes', 'domotic_notifications');

# Drop tables
drop table if exists
    `ombu_domotic_notifications`,
    `ombu_domotic_extensions`,
    `ombu_domotic_scenes`,
    `ombu_domotic_device_parameters`,
    `ombu_domotic_devices`,
    `ombu_domotic_units`,
    `ombu_domotic_models`;