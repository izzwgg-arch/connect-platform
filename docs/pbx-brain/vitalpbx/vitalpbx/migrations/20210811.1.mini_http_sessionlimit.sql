insert into `ombutel`.`ombu_settings` (`module_id`, `name`, `value`)
select
    `module_id`,
    'sessionlimit',
    1000
from `ombutel`.`ombu_modules`
where `name` = 'mini_http_server'
on duplicate key update
    `value` = values(`value`);