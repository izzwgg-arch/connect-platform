use `ombutel`;

alter table `ombu_dynamic_routing_list`
    add index if not exists `idx_drl_destination` (`destination`),
    add index if not exists `idx_drl_used` (`used`),
    add index if not exists `idx_drl_calldate` (`calldate`),
    add index if not exists `idx_drl_tenant` (`tenant_id`);