delete from `astboard`.`controller_actions` where `action` = 'connect' and `controller_id` = (
    select `controller_id` from `astboard`.`module_controllers` where `controller` = 'pbx'
);

insert into `astboard`.`role_permissions` (`role_id`, `action_id`)
    select
      1,
      `action_id`
    from `astboard`.`controller_actions` where `controller_id` = (
      select `controller_id` from `astboard`.`module_controllers` where `controller` = 'pbx'
    ) and `action` != 'index';