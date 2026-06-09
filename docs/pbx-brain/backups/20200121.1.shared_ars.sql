use `ombutel`;

alter table `ombu_classes_of_service`
 add column `shared_ars_id` int unsigned null default null after `ars_id`,
 add foreign key (`shared_ars_id`) references `ombu_ars` (`ars_id`) on delete set null;