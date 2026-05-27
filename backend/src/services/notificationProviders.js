import settingsRepository from './settingsRepository.js';

export async function getNotificationProviderStatus() {
  const sendgridConfig = await settingsRepository.getSendGridConfig();
  const sendgridConfigured = Boolean(sendgridConfig.apiKey && sendgridConfig.fromEmail);
  const sendgridMissing = [
    !sendgridConfig.apiKey ? 'sendgrid_api_key' : null,
    !sendgridConfig.fromEmail ? 'sendgrid_from_email' : null,
  ].filter(Boolean);
  const twilioConfig = await settingsRepository.getTwilioConfig();
  const twilioSmsConfigured = Boolean(twilioConfig.accountSid && twilioConfig.authToken && twilioConfig.fromNumber);
  const twilioVoiceConfigured = twilioSmsConfigured;
  const twilioWhatsAppSenderConfigured = Boolean(twilioConfig.whatsappMessagingServiceSid || twilioConfig.whatsappSender || twilioConfig.fromNumber);
  const twilioWhatsAppConfigured = Boolean(
    twilioConfig.accountSid
    && twilioConfig.authToken
    && twilioWhatsAppSenderConfigured
    && twilioConfig.whatsappContentSid,
  );
  const twilioMissing = [
    !twilioConfig.accountSid ? 'twilio_account_sid' : null,
    !twilioConfig.authToken ? 'twilio_auth_token' : null,
    !twilioConfig.fromNumber ? 'twilio_from_number' : null,
  ].filter(Boolean);
  const twilioWhatsAppMissing = [
    !twilioConfig.accountSid ? 'twilio_account_sid' : null,
    !twilioConfig.authToken ? 'twilio_auth_token' : null,
    !twilioWhatsAppSenderConfigured ? 'twilio_whatsapp_sender_or_messaging_service_sid' : null,
    !twilioConfig.whatsappContentSid ? 'twilio_whatsapp_content_sid' : null,
  ].filter(Boolean);

  return {
    email: {
      provider: 'sendgrid',
      configured: sendgridConfigured,
      missing: sendgridConfigured ? [] : sendgridMissing,
    },
    sms: {
      provider: 'twilio',
      configured: twilioSmsConfigured,
      missing: twilioSmsConfigured ? [] : twilioMissing,
    },
    whatsapp: {
      provider: 'twilio',
      configured: twilioWhatsAppConfigured,
      missing: twilioWhatsAppConfigured ? [] : twilioWhatsAppMissing,
    },
    phone_call: {
      provider: 'twilio',
      configured: twilioVoiceConfigured,
      missing: twilioVoiceConfigured ? [] : twilioMissing,
    },
  };
}

export async function providerForChannel(channel) {
  const status = await getNotificationProviderStatus();
  return status[channel] || { provider: null, configured: false, missing: [] };
}
