require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  databaseUrl: process.env.DATABASE_URL || '',

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
  },

  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    validateSignature: (process.env.TWILIO_VALIDATE_SIGNATURE ?? 'true') === 'true',
  },

  business: {
    defaultTimezone: process.env.DEFAULT_BUSINESS_TIMEZONE || 'America/Chicago',
    hoursStart: parseInt(process.env.BUSINESS_HOURS_START || '8', 10),
    hoursEnd: parseInt(process.env.BUSINESS_HOURS_END || '17', 10),
  },
};

module.exports = config;
