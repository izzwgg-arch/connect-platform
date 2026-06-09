use `ombutel`;

/**
  Remove menu
 */
delete
from `ombu_menu`
where `label` in
      ('menu.telephony_settings', 'menu.interfaces', 'menu.channel_groups', 'menu.profile_assignments',
       'menu.clock_sources', 'menu.telephony');

/**
  Remove privileges
 */
delete
from `ombu_role_privileges`
where module_id in (select `module_id`
                    from `ombu_modules`
                    where `name` in
                          ('dahdi_settings', 'dahdi_hardware', 'dahdi_groups', 'dahdi_clocksource', 'dahdi_spans'));

# Remove modules
delete
from `ombu_modules`
where `name` in ('dahdi_settings', 'dahdi_hardware', 'dahdi_groups', 'dahdi_clocksource', 'dahdi_spans');

# Disable add-on
update `ombu_settings` set `value` = 'no' where `name` = 'dahdi_installed';

# Remove DAHDI devices
delete from ombu_devices where technology in ('fxs', 'fxo', 'telephony', 'dahdi');
delete from ombu_trunks where technology in ('fxs', 'fxo', 'telephony', 'dahdi');

# Remove DAHDI Profiles
delete from ombu_device_profiles where technology in ('fxs', 'fxo', 'bri', 'e1pri', 'e1r2', 't1pri', 't1cas');

# Remove DAHDI Inbound
delete from ombu_inbound_routes where routing_method = 'dahdi';

# Drop ombu_dahdi_channels Foreign keys
# -----------------------------------------------------------------
SET @table_name = 'ombu_dahdi_channels';
SET @column_name = 'span_id';
SET @referenced_table_name = 'ombu_dahdi_spans';
SET @referenced_column_name = 'span_id';
SET @db_name = 'ombutel';

SET @constraint_name = (
    SELECT constraint_name
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    WHERE TABLE_NAME = @table_name
      AND COLUMN_NAME = @column_name
      AND CONSTRAINT_SCHEMA = @db_name
      AND referenced_table_name = @referenced_table_name
      AND referenced_column_name = @referenced_column_name);

SET @s = concat('alter table ', @table_name, ' drop foreign key ', @constraint_name);
PREPARE stmt FROM @s;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @table_name = 'ombu_dahdi_channels';
SET @column_name = 'profile_id';
SET @referenced_table_name = 'ombu_dahdi_profiles';
SET @referenced_column_name = 'profile_id';
SET @db_name = 'ombutel';

SET @constraint_name = (
    SELECT constraint_name
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    WHERE TABLE_NAME = @table_name
      AND COLUMN_NAME = @column_name
      AND CONSTRAINT_SCHEMA = @db_name
      AND referenced_table_name = @referenced_table_name
      AND referenced_column_name = @referenced_column_name);

SET @s = concat('alter table ', @table_name, ' drop foreign key ', @constraint_name);
PREPARE stmt FROM @s;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

# Drop ombu_dahdi_profiles Foreign keys
# -----------------------------------------------------------------
SET @table_name = 'ombu_dahdi_profiles';
SET @column_name = 'profile_id';
SET @referenced_table_name = 'ombu_device_profiles';
SET @referenced_column_name = 'profile_id';
SET @db_name = 'ombutel';

SET @constraint_name = (
    SELECT constraint_name
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    WHERE TABLE_NAME = @table_name
      AND COLUMN_NAME = @column_name
      AND CONSTRAINT_SCHEMA = @db_name
      AND referenced_table_name = @referenced_table_name
      AND referenced_column_name = @referenced_column_name);

SET @s = concat('alter table ', @table_name, ' drop foreign key ', @constraint_name);
PREPARE stmt FROM @s;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

# Drop ombu_dahdi_spans Foreign keys
# -----------------------------------------------------------------
SET @table_name = 'ombu_dahdi_spans';
SET @column_name = 'device_id';
SET @referenced_table_name = 'ombu_dahdi_devices';
SET @referenced_column_name = 'device_id';
SET @db_name = 'ombutel';

SET @constraint_name = (
    SELECT constraint_name
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    WHERE TABLE_NAME = @table_name
      AND COLUMN_NAME = @column_name
      AND CONSTRAINT_SCHEMA = @db_name
      AND referenced_table_name = @referenced_table_name
      AND referenced_column_name = @referenced_column_name);

SET @s = concat('alter table ', @table_name, ' drop foreign key ', @constraint_name);
PREPARE stmt FROM @s;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

# Drop ombu_trunks Foreign keys
# -----------------------------------------------------------------
SET @table_name = 'ombu_trunks';
SET @column_name = 'group_id';
SET @referenced_table_name = 'ombu_dahdi_groups';
SET @referenced_column_name = 'group_id';
SET @db_name = 'ombutel';

SET @constraint_name = (
    SELECT constraint_name
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    WHERE TABLE_NAME = @table_name
      AND COLUMN_NAME = @column_name
      AND CONSTRAINT_SCHEMA = @db_name
      AND referenced_table_name = @referenced_table_name
      AND referenced_column_name = @referenced_column_name);

SET @s = concat('alter table ', @table_name, ' drop foreign key ', @constraint_name);
PREPARE stmt FROM @s;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

# Drop ombu_inbound_routes Foreign keys
# -----------------------------------------------------------------
SET @table_name = 'ombu_inbound_routes';
SET @column_name = 'channel_id';
SET @referenced_table_name = 'ombu_dahdi_channels';
SET @referenced_column_name = 'channel_id';
SET @db_name = 'ombutel';

SET @constraint_name = (
    SELECT constraint_name
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    WHERE TABLE_NAME = @table_name
      AND COLUMN_NAME = @column_name
      AND CONSTRAINT_SCHEMA = @db_name
      AND referenced_table_name = @referenced_table_name
      AND referenced_column_name = @referenced_column_name);

SET @s = concat('alter table ', @table_name, ' drop foreign key ', @constraint_name);
PREPARE stmt FROM @s;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

#Delete Tables
drop table if exists
    `ombu_fxs_devices`,
    `ombu_dahdi_span_caps`,
    `ombu_dahdi_r2_profiles`,
    `ombu_dahdi_digital_spans`,
    `ombu_dahdi_digital_profiles`,
    `ombu_dahdi_channel_groups`,
    `ombu_dahdi_channel_caps`,
    `ombu_dahdi_fxo_profiles`,
    `ombu_dahdi_fxs_profiles`,
    `ombu_dahdi_analog_profiles`,
    `ombu_dahdi_channels`,
    `ombu_dahdi_profiles`,
    `ombu_dahdi_spans`,
    `ombu_dahdi_devices`,
    `ombu_dahdi_groups`;
