use `ombutel`;

delete from ombu_menu where `label` in (
 'menu.ha_monitor'
);

delete from ombu_modules where `name` in (
  'ha_monitor'
);