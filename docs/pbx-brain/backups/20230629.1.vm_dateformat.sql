use `ombutel`;

insert ignore into
    `ombu_settings` (
    `module_id`,
    `name`,
    `value`
) select
      `module_id`,
      'emaildateformat',
      '%A, %B %d %Y, %R'
from `ombu_modules`
where `name` = 'voicemail_general';