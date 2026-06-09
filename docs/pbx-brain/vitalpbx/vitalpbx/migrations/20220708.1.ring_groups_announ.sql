use ombutel;

alter table ombu_ring_groups
 add column `announ_id` int unsigned null default null after `destination_id`,
 add foreign key (`announ_id`) references ombu_recordings (`recording_id`) on delete set null;