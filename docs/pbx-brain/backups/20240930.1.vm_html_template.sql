use `ombutel`;

update ombu_notification_templates
 set `email_body` = '<div style="font-family: Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f4;"><div style="max-width: 600px; margin: 0 auto; background-color: #fff; padding: 20px; box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1); border-radius: 10px;"><!-- Header -->
<div style="background-color: #4caf50; color: white; padding: 10px 20px; border-top-left-radius: 10px; border-top-right-radius: 10px;">
<h1 style="font-size: 24px; margin: 0;">New Voicemail Received</h1>
</div>
<!-- Content -->
<div style="padding: 20px;">
<h2 style="font-size: 18px; color: #333; margin-top: 0;">Hello ${VM_NAME},</h2>
<p style="font-size: 14px; color: #666; line-height: 1.6;">You have received a new voicemail from <strong>${VM_CALLERID}</strong> on <strong>${VM_DATE}</strong>.</p>
<p style="font-size: 14px; color: #666; line-height: 1.6;"><strong>Voicemail details:</strong></p>
<ul style="font-size: 14px; color: #666; line-height: 1.6; padding-left: 20px;">
<li><strong>Caller:</strong> ${VM_CIDNUM}</li>
<li><strong>Duration:</strong> ${VM_DUR}</li>
<li><strong>Date:</strong> ${VM_DATE}</li>
</ul>
<!-- Transcription Section -->
<div style="margin-top: 20px;">
<h2 style="font-size: 16px; color: #333; margin-bottom: 10px;">Voicemail Transcription:</h2>
<p style="font-size: 14px; color: #666; line-height: 1.6; background-color: #f9f9f9; padding: 10px; border-left: 4px solid #4CAF50; border-radius: 5px;">${VM_TRANSCRIPTION}</p>
<p style="font-size: 12px; color: #999; font-style: italic; margin-top: 5px;">*This transcription is auto-generated and may contain inaccuracies.</p>
</div>
<!-- Voicemail Access Instructions -->
<div style="margin-top: 20px;">
<p style="font-size: 14px; color: #666; line-height: 1.6;">You can access your voicemail by dialing <strong>${VM_DIRECT_FC}</strong> from your own extension or <strong>${VM_REMOTE_FC}</strong> from any other extension.</p>
</div>
<!-- Footer -->
<div style="text-align: center; margin-top: 30px; font-size: 12px; color: #999;">
<p>This notification was generated automatically by your PBX system.</p>
<p>${TENANT}</p>
</div>
</div>
</div>
</div>'
where `name` = 'voicemail';