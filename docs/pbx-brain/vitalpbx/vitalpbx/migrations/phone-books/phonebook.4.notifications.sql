use `ombutel`;

insert ignore into `ombu_notification_templates` (`name`, `from_email`, `from_name`, `subject`, `email_body`) values(
    'phonebooks',
    null,
    null,
    '[PhoneBook] ${PHONEBOOK_DESC}',
    'Hi there,<br><br> Here is the QR code for your phonebook "${PHONEBOOK_DESC}". <br><br> ${QRCODE}<br><br> Kind regards,<br>${APP_NAME}'
);