import bcrypt from 'bcrypt';

/**
 * Generate bcrypt password hash
 * Usage: node scripts/generatePasswordHash.js [password]
 */

const password = process.argv[2] || 'admin123';
const saltRounds = 10;

bcrypt.hash(password, saltRounds, (err, hash) => {
  if (err) {
    console.error('Error generating hash:', err);
    process.exit(1);
  }

  console.log('\n=================================');
  console.log('Password Hash Generated');
  console.log('=================================');
  console.log(`Password: ${password}`);
  console.log(`Hash: ${hash}`);
  console.log('\nAdd this to your .env file:');
  console.log(`ADMIN_PASSWORD_HASH="${hash}"`);
  console.log('=================================\n');

  process.exit(0);
});
