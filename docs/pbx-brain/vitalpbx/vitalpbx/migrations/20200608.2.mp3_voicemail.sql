use `ombutel`;

insert ignore into
    `ombu_settings` (
    `module_id`,
    `name`,
    `value`
) select
      `module_id`,
      'mp3_attachment',
      'no'
from `ombu_modules`
where `name` = 'voicemail_general';
