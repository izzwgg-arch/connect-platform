use `ombutel`;

insert ignore into `ombu_notification_templates` (`name`, `from_email`, `from_name`, `subject`, `email_body`) values(
     'mobile_account',
     null,
     null,
     'Your mobile account is ready!',
     '<div class="container" style="font-family: ''Open Sans'', helvetica, sans-serif; margin: auto; width: 750px;"><img class="" style="display: block; margin: auto;" src="https://i.ibb.co/cvVDHqB/246x0w.webp" alt="VitalPBX Connect Logo" width="246" height="246" border="0"><h3>Hello ${EXTENSION_NAME}!</h3><p>Your Mobile account has been successfully set up. Below, you will find the QR Code to scan for configuring your APP.</p><p>&nbsp;</p><p style="text-align: center;"><strong>${QR_CODE}</strong></p><p style="text-align: center;">&nbsp;</p><p>If you have any questions or comments, please let your IT department know.</p><br><p>Kind Regards,<br>${APP_NAME}</p></div>'
);