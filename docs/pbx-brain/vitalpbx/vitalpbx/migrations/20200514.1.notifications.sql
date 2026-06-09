use `ombutel`;

insert into `ombu_modules` (`name`, `has_dialplan`, `admin`, `portal`, `multi_tenant`) values
('notification_templates', 'no', 'yes', 'no','no');

set @module_id = last_insert_id();

insert into `ombu_menu` (`label`, `parent_id`,`module_id`, `sort`)
    select
      'menu.notification_templates',
      `menu_id`,
      @module_id,
      5
    from `ombu_menu` where `label` = 'menu.system_settings' and parent_id is not null;

create table if not exists `ombu_notification_templates` (
    `id` int unsigned not null auto_increment,
    `name` varchar(255) not null,
    `from_email` varchar(255) null default null,
    `from_name` varchar(255) null default null,
    `subject` varchar(255) null default null,
    `email_body` mediumtext null default null,
    primary key(`id`),
    unique (`name`)
) engine=innodb character set utf8 collate utf8_unicode_ci;

/* Give the required privileges for super-admin users */
insert into `ombu_role_privileges` (`role_id`,`module_id`, `allow_view`, `allow_add`, `allow_edit`, `allow_delete`)
select `role_id`,
       m.`module_id`,
       'yes',
       'yes',
       'yes',
       'yes'
from `ombu_roles`
left join ombu_modules as m on (`m`.name in ('notification_templates'))
where `superadmin` = 'yes';

/* Transfer VM Template to Notifications Template and add other default templates */
select `module_id` into @vm_module from `ombu_modules` where `name` = 'voicemail_general';

insert into `ombu_notification_templates` (`name`, `from_email`, `from_name`, `subject`, `email_body`) values
(
    'voicemail',
    (select `value` from `ombu_settings` where `name` = 'serveremail' and `module_id` = @vm_module),
    (select `value` from `ombu_settings` where `name` = 'fromstring' and `module_id` = @vm_module),
    (select `value` from `ombu_settings` where `name` = 'emailsubject' and `module_id` = @vm_module),
    (select `value` from `ombu_settings` where `name` = 'emailbody' and `module_id` = @vm_module)
),
(
    'extensions',
    null,
    null,
    'Welcome to ${APP_NAME}!',
    '<div class="container" style="font-family: ''Open Sans'', helvetica, sans-serif; margin: auto; width: 750px;"><img class="image-center" style="display: block; margin: auto;" src="https://i.ibb.co/pRH0YkT/Vital-PBX-04.png" alt="VitalPBX-logo" width="250" height="auto" border="0" /><h3>Hello ${EXTENSION_NAME}!</h3><p>Your PBX account has been successfully set up. Below, you will find the different information you will need to use it.</p><h2 class="text-center" style="text-align: center;">Register information</h2><p>This is the information you will need for your phone device to register with the PBX. Please let your IT department know about this if you require assistance.</p><table class="mytable" style="border: 1px black solid; padding: 15px; margin: 0; margin-left: auto; margin-right: auto;"><tbody><tr><th style="text-align: right; padding-right: 10px;">Domain/IP:</th><td>${SRVRDOMAIN}</td></tr><tr><th style="text-align: right; padding-right: 10px;">Extension number:</th><td>${EXTENSION}</td></tr><tr><th style="text-align: right; padding-right: 10px;">Device Username:</th><td>${DEVICE}</td></tr><tr><th style="text-align: right; padding-right: 10px;">Device Password:</th><td>${SECRET}</td></tr></tbody></table><h2 class="text-center" style="text-align: center;">Portal and Phone Information</h2><p>The following credentials are your login credentials to your user portal. There, you can listen to your voicemails, change your features password, and configure your personal assistant and Call Forwards.</p><table class="mytable" style="border: 1px black solid; padding: 15px; margin: 0; margin-left: auto; margin-right: auto;"><tbody><tr><th style="text-align: right; padding-right: 10px;">Website URL:</th><td>${PUBLICIP}</td></tr><tr><th style="text-align: right; padding-right: 10px;">Username:</th><td>${PORTALUSER}</td></tr><tr><th style="text-align: right; padding-right: 10px;">Password:</th><td>${PORTALPASSWORD}</td></tr><tr><th style="text-align: right; padding-right: 10px;">Features Password:</th><td>${FEATPWD}</td></tr><tr><th style="text-align: right; padding-right: 10px;">Voicemail code:</th><td>${VMCODE}</td></tr><tr><th style="text-align: right; padding-right: 10px;">Voicemail Password:</th><td>${VMPWD}</td></tr></tbody></table><p>You can click on the button below to check out the website, and get started customizing your account.</p><center style="padding: 25px 0;"><a class="mybutton" style="background-color: #50912e; text-align: center; border-radius: 10px; width: auto; height: auto; font-size: 16px; padding: 15px; text-decoration: none; color: white; margin-left: auto; margin-right: auto;" href="https://vitalpbx.com/" target="_blank" rel="noopener" type="button">Visit Website</a></center><p>If you have any questions or comments, please let your IT department know.</p><br /><p>Kind Regards,<br />${APP_NAME}</p></div>'
),
(
    'emergency',
    null,
    null,
    '${EMERGENCY_NUMBER} Dialed on ${EMERGENCY_LOCATION_NAME}',
    'A call from the extension/device ${EXTENSION} has just been placed to emergency phone number ${EMERGENCY_NUMBER}. Be prepared to direct emergency personnel and facilitate a response.<br><br><b>Location Information</b><br><br>${DISPATCHABLE_LOCATION}<br><br>${APP_NAME}'
),
(
    'tenants',
    null,
    null,
    'Your PBX is now ready!',
    'Hello ${TENANT_ADMIN_NAME}, <br><br>Your PBX has now been setup!, Here is your Login Information so you can start managing your PBX.<br><br><b>Account Information</b><br><br><b>URL:</b>${SRVDOMAIN}<br><b>Username:</b>${USER_NAME}<br><b>Password:</b>${PASSWORD}<br><br> Kind regards,<br>${APP_NAME}'
);




