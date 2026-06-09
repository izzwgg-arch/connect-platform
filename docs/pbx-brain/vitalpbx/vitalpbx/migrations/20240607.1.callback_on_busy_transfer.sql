use `ombutel`;

alter table ombu_extensions
    add column if not exists callback_on_busy_transfer enum('yes','no') not null default 'no' after `notify_missed_calls`;