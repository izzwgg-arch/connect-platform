use `ombutel`;

update ombu_menu set
  `icon` = 'fas fa-phone-volume' where `label` = 'menu.pbx';

update ombu_menu set
  `icon` = 'fas fa-copy' where `label` = 'menu.reports';

update ombu_menu set
  `icon` = 'fas fa-user-tie' where `label` = 'menu.admin';

update ombu_menu set
  `icon` = 'fas fa-toolbox' where `label` = 'menu.applications';

update ombu_menu set
  `icon` = 'fas fa-door-open' where `label` = 'menu.class_of_service';

update ombu_menu set
  `icon` = 'fas fa-headset' where `label` = 'menu.callcenter';

update ombu_menu set
  `icon` = 'fas fa-broadcast-tower' where `label` = 'menu.external';

update ombu_menu set
  `icon` = 'fas fa-route' where `label` = 'menu.incoming_calls';

update ombu_menu set
  `icon` = 'fas fa-tools' where `label` = 'menu.tools';

update ombu_menu set
  `icon` = 'fas fa-voicemail' where `label` = 'menu.voicemail_settings';

update ombu_menu set
  `icon` = 'fas fa-server' where `label` = 'menu.pbx_settings';

update ombu_menu set
  `icon` = 'fas fa-shield-alt' where `label` = 'menu.security';

update ombu_menu set
  `icon` = 'fas fa-file-pdf' where `label` = 'menu.cdr_reports';

update ombu_menu set
  `icon` = 'fas fa-file-medical-alt' where `label` = 'menu.pbx_reports';

update ombu_menu set
  `icon` = 'fas fa-user-cog' where `label` = 'menu.portal';
