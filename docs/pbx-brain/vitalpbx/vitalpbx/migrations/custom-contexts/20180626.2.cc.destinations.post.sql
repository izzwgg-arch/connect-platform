alter table `ombutel`.`ombu_custom_contexts`
  modify column `destination_id` int unsigned not null,
  add foreign key(`destination_id`) references `ombu_destinations` (`id`) on delete restrict;