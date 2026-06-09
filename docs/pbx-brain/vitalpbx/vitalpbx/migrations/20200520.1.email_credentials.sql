use `ombutel`;

insert ignore into
    `ombu_settings` (
    `module_id`,
    `name`,
    `value`
) select
      `module_id`,
      'email_credentials',
      'yes'
from `ombu_modules`
where `name` = 'vitalpbx';
