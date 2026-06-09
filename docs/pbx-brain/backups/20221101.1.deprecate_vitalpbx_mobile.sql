use `ombutel`;

alter table `ombu_devices`
    drop column `generate_qr`;

delete from ombu_firewall_whitelist where `host` = '3.212.223.16';

/* Force the Firewall Reload */
select `module_id` into @module from `ombu_modules` where `name` = 'firewall';

insert ignore into `ombutel`.`ombu_settings` (`module_id`, `name`, `value`) values
    (@module, 'reload', 'yes')
on duplicate key update `value` = if(`value` = 'no', values(`value`), `value`);