use `ombutel`;

create table `ice_host_candidates` (
    `local_address` varchar(255) not null,
    `advertised_address` varchar(255) not null,
    `include_local_address` enum('yes', 'no') not null default 'no'
);