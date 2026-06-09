alter table `asterisk`.`cdr`
    add index if not exists `cdr_linkedid_index` (`linkedid`);