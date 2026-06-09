use `ombutel`;

alter table ombu_extensions
 add column if not exists notify_missed_calls varchar(255) null default null after `dynamic_routing`;

insert ignore into `ombu_notification_templates` (`name`, `from_email`, `from_name`, `subject`, `email_body`) values(
    'missed_call',
    null,
    null,
    'You have a missed call from ${CID_NUMBER}',
    '<div class="container" style="font-family:\'Open Sans\',helvetica,sans-serif;margin:auto;width:750px"><h2 style="text-align:center"><span style="font-size:14pt"><strong>You have a missed call from ${CID_NUMBER}.</strong></span></h2><p style="text-align:center"><span style="font-size:10pt">Hi ${EXTENSION_NAME}, someone was trying to reach you but you weren\'t available!</span></p><table class="mytable" style="border:1px solid gray;padding:15px;margin:0 auto;height:160px;width:420px" width="338"><tbody><tr><td style="width:405.219px;text-align:center"><strong>Time:</strong>${DATE}</td></tr><tr><td style="width:405.219px;text-align:center"><strong>Call From:</strong>${CID_NUMBER}</td></tr><tr><td style="width:405.219px;text-align:center"><strong>Call To:</strong>${EXTENSION}</td></tr><tr><td style="width:405.219px;text-align:center"><strong>Reason:</strong>${REASON}</td></tr><tr><td style="width:405.219px;text-align:center"><strong>App:</strong>${ORIGIN}</td></tr></tbody></table><p style="text-align:center">&nbsp;</p><p style="text-align:left">Kind Regards,<br>${TENANT}</p></div>'
);