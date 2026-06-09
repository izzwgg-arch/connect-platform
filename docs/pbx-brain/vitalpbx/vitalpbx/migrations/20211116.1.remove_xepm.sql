use `ombutel`;

/* Remove XEPM menu */
delete from `ombu_menu` where `label` in
  ('menu.epm_host_settings', 'menu.epm_template', 'menu.epm_device_mapping');

/* Remove privileges */
delete
from `ombu_role_privileges`
where module_id in
      (select `module_id` from ombu_modules where `name` in ('epm_host_settings', 'epm_template', 'epm_device_mapping'));

/* Remove modules */
delete from ombu_modules where `name` in ('epm_host_settings', 'epm_template', 'epm_device_mapping', 'endpoint');

/* Disable the add-on */
update `ombu_settings` set `value` = 'no' where `name` = 'xepm_installed';

/* Remove tables */
drop table if exists
    `xepm_model_lines`,
    `xepm_device_modules`,
    `xepm_device_extensions`,
    `xepm_device_settings`,
    `xepm_devices`,
    `xepm_template_settings`,
    `xepm_template_modules`,
    `xepm_templates`,
    `xepm_timezones`,
    `xepm_settings`,
    `xepm_setting_types`,
    `xepm_configuration_types`,
    `xepm_model_button_types`,
    `xepm_button_types`,
    `xepm_button_categories`,
    `xepm_addresses`,
    `xepm_lines`,
    `xepm_model_modules`,
    `xepm_modules`,
    `xepm_models`,
    `xepm_hosts`,
    `xepm_ouis`,
    `xepm_brands`;

