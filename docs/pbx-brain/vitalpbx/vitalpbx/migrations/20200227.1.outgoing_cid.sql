use `ombutel`;

alter table `ombu_outbound_routes`
    modify column `overwrite_cid` varchar(255) not null default 'no';

alter table `ombu_trunks`
    modify column `overwrite_cid` varchar(255) not null default 'no';