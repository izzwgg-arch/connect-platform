use `ombutel`;

/* Qualify Frequency */
insert into `ombu_trunk_parameters` (`trunk_id`, `advanced_param`, `type`, `param`, `value`, `enabled`, `sort`)
 select
   `trunk_id`,
   'no',
   'peer',
   'outgoing_qualify_frequency',
   30,
   'yes',
    0
 from `ombu_trunks` where `technology` = 'pjsip';

/* Qualify Timeout */
insert into `ombu_trunk_parameters` (`trunk_id`, `advanced_param`, `type`, `param`, `value`, `enabled`, `sort`)
select
    `trunk_id`,
    'no',
    'peer',
    'outgoing_qualify_timeout',
    3,
    'yes',
    0
from `ombu_trunks` where `technology` = 'pjsip';