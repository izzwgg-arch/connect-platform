use `ombutel`;

insert ignore into
    `ombu_settings` (
    `module_id`,
    `name`,
    `value`
) select
      `module_id`,
      'locale',
      'en_US.utf8'
from `ombu_modules`
where `name` = 'voicemail_general';