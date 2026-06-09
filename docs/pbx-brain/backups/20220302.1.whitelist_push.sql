use `ombutel`;

/* Insert the push server only if it doesn't exist */
INSERT INTO `ombu_firewall_whitelist` (`host`, `description`)
SELECT '3.212.223.16', 'Mobile\'s Push Server' FROM DUAL
WHERE NOT EXISTS (SELECT `firewall_whitelist_id` FROM `ombu_firewall_whitelist`
                  WHERE `host`='3.212.223.16' LIMIT 1);

/* Force the Firewall Reload */
select `module_id` into @module from `ombu_modules` where `name` = 'firewall';

insert ignore into `ombutel`.`ombu_settings` (`module_id`, `name`, `value`) values
    (@module, 'reload', 'yes')
on duplicate key update `value` = if(`value` = 'no', values(`value`), `value`);