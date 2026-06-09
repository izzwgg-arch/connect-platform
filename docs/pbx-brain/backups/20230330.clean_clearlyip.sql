use `ombutel`;

delete from ombu_menu where `label` in (
    'menu.clearlyip_settings',
    'menu.clearlyip_dids',
    'menu.clearlyip_cb_profiles',
    'menu.clearlyip'
);

delete from ombu_modules where `name` in (
  'clearlyip_settings',
  'clearlyip_dids',
  'clearlyip_cb_profiles'
);