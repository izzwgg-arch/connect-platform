alter table `ombutel`.`ombu_custom_contexts`
  drop column `mod_dest`,
  change column `dest` `destination_id` varchar(255) null default null;