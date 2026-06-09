use `ombutel`;

alter table ombu_extensions
    add column if not exists `sms_number_id` int unsigned null default null after `dynamic_routing`;