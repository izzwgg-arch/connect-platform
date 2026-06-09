use `ombutel`;

delete from ombu_addons where `package` in (
    'vitalpbx-g729',
    'vitalpbx-epm',
    'vitalpbx-domotic',
    'vitalpbx-dahdi',
    'vitalpbx-clearlyip',
    'sonata-common',
   'vitalpbx-high-availability',
   'vitalpbx-vitxi-server',
   'vitalpbx-communicator'
);
