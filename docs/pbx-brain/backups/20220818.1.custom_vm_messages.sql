use `ombutel`;

alter table ombu_extensions_vm
 add column `busy_greeting_id` int unsigned null default null,
 add column `unav_greeting_id` int unsigned null default null,
 add foreign key (`busy_greeting_id`) references ombu_recordings (`recording_id`) on delete set null,
 add foreign key (`unav_greeting_id`) references ombu_recordings (`recording_id`) on delete set null;