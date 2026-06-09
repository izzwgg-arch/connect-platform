use `ombutel`;

alter table `ombu_queues_callback`
    add column if not exists `dtmf_digit` int unsigned null default null after `allowed_tries`;