use `asterisk`;

alter table `queues_log`
    add index if not exists `ast_queues_log_data1_idx` (`data1`),
    add index if not exists `ast_queues_log_data2_idx` (`data2`),
    add index if not exists `ast_queues_log_data3_idx` (`data3`);